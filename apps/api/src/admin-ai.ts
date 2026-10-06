import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, gte, ilike, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { activateSettingsVersion, handleQuestion, loadSettings, saveSettings, settingsHistory, spend, type ChatEvent } from "@oa/agents";
import { documents, feedback, llmCalls, messages, modelPrices, screens, spans, traces, videoJobs } from "@oa/db";
import { ScreenDescription } from "@oa/shared";
import { audit } from "./audit.js";
import { requireRole } from "./auth.js";
import { chatUser } from "./chat.js";
import type { ServerDeps } from "./server.js";

const admin = requireRole("Assistant.Admin");
const reviewer = requireRole("Assistant.Admin", "Assistant.ContentReviewer");
const IdParam = z.object({ id: z.string().uuid() });
const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function adminAiRoutes(app: FastifyInstance, deps: ServerDeps) {
  const { db, enqueue } = deps;

  // ---- Settings (versioned) ----
  app.get("/settings", { preHandler: admin }, async () => loadSettings(db));
  app.put("/settings", { preHandler: admin }, async (req) => {
    const before = await loadSettings(db);
    const saved = await saveSettings(db, req.body, req.user!.id);
    await audit(db, req, "update", "settings", String(saved.version), before, saved.value);
    return saved;
  });
  app.get("/settings/history", { preHandler: admin }, async () => settingsHistory(db));
  app.post("/settings/:version/activate", { preHandler: admin }, async (req, reply) => {
    const { version } = z.object({ version: z.coerce.number().int() }).parse(req.params);
    if (!(await activateSettingsVersion(db, version))) return reply.code(404).send({ error: "Not found" });
    await audit(db, req, "rollback", "settings", String(version));
    return loadSettings(db);
  });

  // ---- Screens ----
  app.get("/screens", { preHandler: reviewer }, async (req) => {
    const q = Paging.extend({ status: z.enum(["pending", "described", "failed", "verified", "all"]).default("all"), ucId: z.string().optional() }).parse(req.query);
    const filters: (SQL | undefined)[] = [
      isNull(documents.deletedAt),
      q.ucId ? eq(screens.ucId, q.ucId.toUpperCase()) : undefined,
      q.status === "pending" ? and(isNull(screens.description), isNull(screens.describeError)) : undefined,
      q.status === "described" ? isNotNull(screens.description) : undefined,
      q.status === "failed" ? isNotNull(screens.describeError) : undefined,
      q.status === "verified" ? eq(screens.verified, true) : undefined,
    ];
    return db
      .select({
        id: screens.id,
        ucId: screens.ucId,
        caption: screens.caption,
        description: screens.description,
        verified: screens.verified,
        describeError: screens.describeError,
        documentName: documents.name,
        documentId: documents.id,
      })
      .from(screens)
      .innerJoin(documents, eq(documents.id, screens.documentId))
      .where(and(...filters))
      .orderBy(asc(screens.ucId), asc(documents.name), asc(screens.ordinal))
      .limit(q.limit)
      .offset(q.offset);
  });

  /** Correct element labels/boxes and mark a screen as verified by a person. */
  app.patch("/screens/:id", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ description: ScreenDescription.optional(), verified: z.boolean().optional() }).parse(req.body);
    const [before] = await db.select().from(screens).where(eq(screens.id, id));
    if (!before) return reply.code(404).send({ error: "Not found" });
    await db.update(screens).set(body).where(eq(screens.id, id));
    await audit(db, req, "update", "screen", id, { description: before.description, verified: before.verified }, body);
    return { ok: true };
  });

  app.post("/screens/:id/redescribe", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [row] = await db.update(screens).set({ description: null, describeError: null, verified: false }).where(eq(screens.id, id)).returning({ id: screens.id });
    if (!row) return reply.code(404).send({ error: "Not found" });
    await enqueue({ name: "describe-screens", data: {} });
    await audit(db, req, "redescribe", "screen", id);
    return reply.code(202).send({ queued: true });
  });

  // ---- Sessions & traces ----
  app.get("/sessions", { preHandler: reviewer }, async (req) => {
    const q = Paging.extend({
      kind: z.string().default("chat"),
      outcome: z.string().optional(),
      userId: z.string().optional(),
      q: z.string().optional(),
      days: z.coerce.number().int().min(1).max(365).default(30),
    }).parse(req.query);
    const since = new Date(Date.now() - q.days * 86_400_000);
    return db
      .select()
      .from(traces)
      .where(
        and(
          eq(traces.kind, q.kind),
          gte(traces.createdAt, since),
          q.outcome ? eq(traces.outcome, q.outcome) : undefined,
          q.userId ? eq(traces.userId, q.userId) : undefined,
          q.q ? ilike(traces.question, `%${q.q}%`) : undefined,
        ),
      )
      .orderBy(desc(traces.createdAt))
      .limit(q.limit)
      .offset(q.offset);
  });

  /** One trace as a timeline: each step's decisions plus tokens and cost per model call. */
  app.get("/traces/:id", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [trace] = await db.select().from(traces).where(eq(traces.id, id));
    if (!trace) return reply.code(404).send({ error: "Not found" });
    const [steps, calls, answer] = await Promise.all([
      db.select().from(spans).where(eq(spans.traceId, id)).orderBy(asc(spans.ordinal)),
      db.select().from(llmCalls).where(eq(llmCalls.traceId, id)).orderBy(asc(llmCalls.createdAt)),
      db.select({ id: messages.id, content: messages.content, outcome: messages.outcome, payload: messages.payload }).from(messages).where(eq(messages.traceId, id)),
    ]);
    await audit(db, req, "view", "trace", id);
    return { trace, spans: steps, calls, answer: answer[0] ? { ...answer[0], payload: { sources: answer[0].payload?.sources } } : null };
  });

  // ---- Usage & cost ----
  app.get("/usage", { preHandler: reviewer }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const inRange = gte(llmCalls.createdAt, since);
    const totals = {
      costUsd: sql<number>`coalesce(sum(llm_calls.cost_usd), 0)::float`,
      inputTokens: sql<number>`coalesce(sum(llm_calls.input_tokens), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(llm_calls.output_tokens), 0)::int`,
      cacheReadTokens: sql<number>`coalesce(sum(llm_calls.cache_read_tokens), 0)::int`,
      calls: sql<number>`count(*)::int`,
    };
    const day = sql<string>`to_char(date_trunc('day', llm_calls.created_at), 'YYYY-MM-DD')`;
    const [byDay, byModel, byStep, byUser, sessionStats, videoCache] = await Promise.all([
      db.select({ day, ...totals }).from(llmCalls).where(inRange).groupBy(day).orderBy(day),
      db.select({ model: llmCalls.model, ...totals }).from(llmCalls).where(inRange).groupBy(llmCalls.model).orderBy(desc(totals.costUsd)),
      db.select({ step: llmCalls.step, ...totals }).from(llmCalls).where(inRange).groupBy(llmCalls.step).orderBy(desc(totals.costUsd)),
      db
        .select({ userId: llmCalls.userId, userName: sql<string | null>`max(traces.user_name)`, ...totals })
        .from(llmCalls)
        .leftJoin(traces, eq(traces.id, llmCalls.traceId))
        .where(and(inRange, isNotNull(llmCalls.userId)))
        .groupBy(llmCalls.userId)
        .orderBy(desc(totals.costUsd))
        .limit(50),
      db
        .select({
          sessions: sql<number>`count(*)::int`,
          avgCostUsd: sql<number>`coalesce(avg(traces.cost_usd), 0)::float`,
          avgTokens: sql<number>`coalesce(avg((select sum(c.input_tokens + c.output_tokens + c.cache_read_tokens) from llm_calls c where c.trace_id = traces.id)), 0)::float`,
          refused: sql<number>`count(*) filter (where traces.outcome = 'refused')::int`,
          partial: sql<number>`count(*) filter (where traces.outcome = 'partial')::int`,
        })
        .from(traces)
        .where(and(eq(traces.kind, "chat"), gte(traces.createdAt, since))),
      db
        .select({
          hits: sql<number>`count(*) filter (where (spans.data->>'cacheHit')::boolean)::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(spans)
        .where(and(eq(spans.name, "video_job"), gte(spans.startedAt, since), sql`spans.data ? 'cacheHit'`)),
    ]);
    const tokenTotals = byModel.reduce((a, m) => ({ input: a.input + m.inputTokens, cacheRead: a.cacheRead + m.cacheReadTokens }), { input: 0, cacheRead: 0 });
    return {
      days,
      byDay,
      byModel,
      byStep,
      byUser,
      sessions: sessionStats[0],
      promptCacheHitRate: tokenTotals.input + tokenTotals.cacheRead ? tokenTotals.cacheRead / (tokenTotals.input + tokenTotals.cacheRead) : 0,
      videoCache: videoCache[0],
    };
  });

  /** Spend against limits, with the alert level shown as a banner in the admin UI. */
  app.get("/budget", { preHandler: reviewer }, async (req) => {
    const settings = await loadSettings(db);
    const s = await spend(db, req.user!.id);
    const ratio = Math.max(s.todayUsd / (settings.budget.dailyUsd || Infinity), s.monthUsd / (settings.budget.monthlyUsd || Infinity));
    return { ...s, limits: settings.budget, level: ratio >= 1 ? "blocked" : ratio >= 0.8 ? "warning" : "ok" };
  });

  app.get("/prices", { preHandler: admin }, async () => db.select().from(modelPrices).orderBy(asc(modelPrices.model)));
  app.put("/prices/:model", { preHandler: admin }, async (req) => {
    const { model } = z.object({ model: z.string().min(1) }).parse(req.params);
    const body = z
      .object({ inputPerM: z.number().min(0), outputPerM: z.number().min(0), cacheReadPerM: z.number().min(0), cacheWritePerM: z.number().min(0) })
      .parse(req.body);
    const [before] = await db.select().from(modelPrices).where(eq(modelPrices.model, model));
    await db.insert(modelPrices).values({ model, ...body }).onConflictDoUpdate({ target: modelPrices.model, set: { ...body, updatedAt: new Date() } });
    await audit(db, req, "update", "price", model, before ?? null, body);
    return { model, ...body };
  });

  // ---- Playground ----
  /** Runs the real pipeline and returns the decisions, for tuning thresholds before saving them. */
  app.post("/playground", { preHandler: admin }, async (req) => {
    const { question } = z.object({ question: z.string().trim().min(1).max(2000) }).parse(req.body);
    const events: ChatEvent[] = [];
    await handleQuestion(deps.pipeline, { question, user: { ...chatUser(req.user!), name: `${req.user!.name ?? "admin"} (playground)` } }, (e) => events.push(e));
    const answer = events.find((e): e is Extract<ChatEvent, { type: "answer" }> => e.type === "answer");
    const [msg] = answer ? await db.select({ traceId: messages.traceId }).from(messages).where(eq(messages.id, answer.messageId)) : [];
    const steps = msg?.traceId ? await db.select().from(spans).where(eq(spans.traceId, msg.traceId)).orderBy(asc(spans.ordinal)) : [];
    const calls = msg?.traceId ? await db.select().from(llmCalls).where(eq(llmCalls.traceId, msg.traceId)) : [];
    return { events, traceId: msg?.traceId, spans: steps, calls };
  });

  // ---- Insights ----
  app.get("/insights", { preHandler: reviewer }, async (req) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    const [refused, negative, topUcs] = await Promise.all([
      // Questions the documentation could not answer: the gaps to fill.
      db
        .select({
          traceId: traces.id,
          question: traces.question,
          userName: traces.userName,
          createdAt: traces.createdAt,
          reason: sql<string | null>`(select m.payload->>'refusal' from messages m where m.trace_id = traces.id limit 1)`,
        })
        .from(traces)
        .where(and(eq(traces.kind, "chat"), eq(traces.outcome, "refused"), gte(traces.createdAt, since)))
        .orderBy(desc(traces.createdAt))
        .limit(100),
      db
        .select({ messageId: messages.id, answer: messages.content, comment: feedback.comment, traceId: messages.traceId, createdAt: feedback.createdAt })
        .from(feedback)
        .innerJoin(messages, eq(messages.id, feedback.messageId))
        .where(and(eq(feedback.rating, -1), gte(feedback.createdAt, since)))
        .orderBy(desc(feedback.createdAt))
        .limit(100),
      db
        .select({ ucId: sql<string>`s->>'ucId'`, count: sql<number>`count(*)::int` })
        .from(sql`messages, jsonb_array_elements(coalesce(messages.payload->'sources', '[]'::jsonb)) s`)
        .where(sql`messages.created_at >= ${since.toISOString()}::timestamptz and s->>'ucId' is not null`)
        .groupBy(sql`s->>'ucId'`)
        .orderBy(desc(sql`count(*)`))
        .limit(20),
    ]);
    return { days, refused, negativeFeedback: negative, topUseCases: topUcs };
  });

  app.get("/videos", { preHandler: reviewer }, async (req) => {
    const q = Paging.parse(req.query);
    return db
      .select({
        id: videoJobs.id,
        question: videoJobs.question,
        status: videoJobs.status,
        ucIds: videoJobs.ucIds,
        durationSec: videoJobs.durationSec,
        hasVoice: videoJobs.hasVoice,
        storyboard: videoJobs.storyboard,
        error: videoJobs.error,
        traceId: videoJobs.traceId,
        createdAt: videoJobs.createdAt,
      })
      .from(videoJobs)
      .orderBy(desc(videoJobs.createdAt))
      .limit(q.limit)
      .offset(q.offset);
  });
}
