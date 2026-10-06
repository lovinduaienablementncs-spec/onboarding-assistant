import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import { chunks, conversations, documents, llmCalls, messages, screens, videoJobs, type Db } from "@oa/db";
import type { AssistantSettings, Audience, Intent } from "@oa/shared";
import { groundAnswer, type GroundedAnswer, type Source } from "./grounding.js";
import type { Models, RouteResult } from "./models.js";
import type { Retriever } from "./retrieval.js";
import { loadSettings } from "./settings.js";
import { Tracer } from "./trace.js";

export interface ChatUser {
  id: string;
  name?: string;
  /** Developers get developer-style answers by default. */
  defaultAudience: Audience;
  /** Principals for document security trimming; undefined = no trimming. */
  principals?: string[];
}

export type ChatEvent =
  | { type: "status"; step: string }
  | { type: "answer"; messageId: string; conversationId: string; outcome: GroundedAnswer["outcome"]; markdown: string; sources: Source[]; intent: Intent }
  | { type: "video"; jobId: string; status: string }
  | { type: "error"; message: string };

export interface PipelineDeps {
  db: Db;
  models: Models;
  retriever: Retriever;
  /** Queues a video job for the worker. */
  enqueueVideo(jobId: string): Promise<unknown>;
  settings?: () => Promise<AssistantSettings>;
}

export interface VideoJobInput {
  question: string;
  audience: Audience;
  steps: Array<{ id: number; text: string; quotes: string[]; chunkIds: string[] }>;
  screenIds: string[];
}

const BUDGET_MESSAGE = "The assistant has reached its usage limit for now. Please try again later.";

/**
 * Handles one user question end to end and reports progress through `emit`.
 * The answer text is only sent after grounding, so unverified text never
 * reaches the user.
 */
export async function handleQuestion(
  deps: PipelineDeps,
  input: { question: string; conversationId?: string; user: ChatUser },
  emit: (e: ChatEvent) => void,
): Promise<void> {
  const { db, models, retriever } = deps;
  const settings = await (deps.settings ?? (() => loadSettings(db)))();
  const conversationId = input.conversationId ?? (await newConversation(db, input.user, input.question));
  const history = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  await db.insert(messages).values({ conversationId, role: "user", content: input.question });
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));

  const tracer = new Tracer(db, { kind: "chat", conversationId, userId: input.user.id, userName: input.user.name, question: input.question });

  const finish = async (result: Omit<Extract<ChatEvent, { type: "answer" }>, "type" | "messageId" | "conversationId">, extra: Record<string, unknown> = {}) => {
    const [msg] = await db
      .insert(messages)
      .values({
        conversationId,
        role: "assistant",
        content: result.markdown,
        outcome: result.outcome,
        payload: { sources: result.sources, intent: result.intent, ...extra },
        traceId: tracer.id,
      })
      .returning({ id: messages.id });
    await tracer.finish(result.outcome);
    emit({ type: "answer", messageId: msg!.id, conversationId, ...result });
    return msg!.id;
  };

  try {
    // Budget guard: stop before spending when a limit is reached.
    const overBudget = await tracer.span("budget", async (data) => {
      const spent = await spend(db, input.user.id);
      Object.assign(data, spent, { limits: settings.budget });
      return (
        spent.todayUsd >= settings.budget.dailyUsd ||
        spent.monthUsd >= settings.budget.monthlyUsd ||
        spent.userTodayUsd >= settings.budget.perUserDailyUsd
      );
    });
    if (overBudget) {
      await finish({ outcome: "refused", markdown: BUDGET_MESSAGE, sources: [], intent: "explain" }, { refusal: "budget" });
      return;
    }

    emit({ type: "status", step: "understanding" });
    const route: RouteResult = await tracer.span("router", async (data) => {
      const r = await models.route({ question: input.question, history, defaultAudience: input.user.defaultAudience }, tracer);
      Object.assign(data, r);
      return r;
    });
    const intent: Intent = route.intent === "clarify" ? "explain" : route.intent;

    const refuse = (reason: string) =>
      finish({ outcome: "refused", markdown: settings.grounding.refusalMessage, sources: [], intent }, { refusal: reason });

    // Scope gate 1: clearly unrelated questions never reach retrieval or the answer model.
    if (route.intent === "out_of_scope") {
      await tracer.span("scope_gate", async (data) => Object.assign(data, { passed: false, reason: "router: out_of_scope" }));
      await refuse("out_of_scope");
      return;
    }

    emit({ type: "status", step: "searching" });
    const found = await retriever.search(route.rewrittenQuery || input.question, { topK: settings.grounding.topK, ucHints: route.ucHints, principals: input.user.principals }, tracer);

    // Scope gate 2: refuse without calling the answer model when nothing relevant was found.
    const relevant = found.filter((c) => c.score >= settings.grounding.minRelevance);
    const gate = await tracer.span("scope_gate", async (data) => {
      const passed = relevant.length >= settings.grounding.minChunks;
      Object.assign(data, {
        passed,
        topScore: found[0]?.score ?? 0,
        relevant: relevant.length,
        minRelevance: settings.grounding.minRelevance,
        minChunks: settings.grounding.minChunks,
      });
      return passed;
    });
    if (!gate) {
      await refuse("low_relevance");
      return;
    }

    emit({ type: "status", step: "writing" });
    const draft = await tracer.span("answer", async (data) => {
      const d = await models.answer({ question: input.question, audience: route.audience, intent, chunks: relevant }, tracer);
      Object.assign(data, { model: d.model, refused: d.refused, blocks: d.blocks.length, citedBlocks: d.blocks.filter((b) => b.citations.length).length });
      return d;
    });
    if (draft.refused) {
      await refuse("model_refusal");
      return;
    }

    emit({ type: "status", step: "checking" });
    const grounded = await tracer.span("grounding", async (data) => {
      const g = await groundAnswer(draft.blocks, relevant, (claims) => models.verify(claims, tracer), settings.grounding);
      Object.assign(data, {
        outcome: g.outcome,
        keptClaims: g.claims.map((c) => ({ id: c.id, text: c.text.trim().slice(0, 300), chunks: c.citations.map((x) => x.chunkId) })),
        removed: g.removed,
        gapStatements: g.gapStatements,
      });
      return g;
    });

    const steps = toSteps(grounded);
    let videoJobId: string | undefined;
    if (intent === "ui_howto" && grounded.outcome !== "refused") {
      videoJobId = await createVideoJob(deps, tracer, { question: input.question, cacheQuery: route.rewrittenQuery, audience: route.audience, steps });
    }

    await finish(
      { outcome: grounded.outcome, markdown: grounded.markdown, sources: grounded.sources, intent },
      // Verified steps are kept so a video can also be requested later for an explanation.
      { audience: route.audience, videoJobId, steps, rewrittenQuery: route.rewrittenQuery },
    );
    if (videoJobId) {
      const [job] = await db.select({ status: videoJobs.status }).from(videoJobs).where(eq(videoJobs.id, videoJobId));
      emit({ type: "video", jobId: videoJobId, status: job?.status ?? "queued" });
    }
  } catch (err) {
    await tracer.finish("error").catch(() => {});
    emit({ type: "error", message: "Something went wrong while answering. Please try again." });
    throw err;
  }
}

async function newConversation(db: Db, user: ChatUser, question: string): Promise<string> {
  const [c] = await db
    .insert(conversations)
    .values({ userId: user.id, userName: user.name, title: question.slice(0, 80) })
    .returning({ id: conversations.id });
  return c!.id;
}

/** Spend so far today, this month, and by this user today (UTC). */
export async function spend(db: Db, userId: string) {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sum = (since: Date, user?: string) =>
    db
      .select({ usd: sql<number>`coalesce(sum(${llmCalls.costUsd}), 0)::float` })
      .from(llmCalls)
      .where(and(gte(llmCalls.createdAt, since), user ? eq(llmCalls.userId, user) : undefined))
      .then((r) => Number(r[0]?.usd ?? 0));
  const [todayUsd, monthUsd, userTodayUsd] = await Promise.all([sum(day), sum(month), sum(day, userId)]);
  return { todayUsd, monthUsd, userTodayUsd };
}

/** Verified claims as video steps, with the quotes that support them. */
export function toSteps(grounded: GroundedAnswer): VideoJobInput["steps"] {
  return grounded.claims.map((c) => ({
    id: c.id,
    text: c.text.trim(),
    quotes: c.citations.map((x) => x.citedText),
    chunkIds: [...new Set(c.citations.map((x) => x.chunkId))],
  }));
}

/**
 * Creates (or reuses) a video job from verified steps. The same question over
 * the same document versions reuses an existing video.
 */
export async function createVideoJob(
  deps: Pick<PipelineDeps, "db" | "enqueueVideo">,
  tracer: Tracer,
  input: { question: string; cacheQuery: string; audience: Audience; steps: VideoJobInput["steps"] },
): Promise<string | undefined> {
  const { db } = deps;
  return tracer.span("video_job", async (data) => {
    const chunkIds = [...new Set(input.steps.flatMap((s) => s.chunkIds))];
    if (!chunkIds.length) {
      Object.assign(data, { skipped: "no verified steps" });
      return undefined;
    }
    const origin = await db
      .select({ documentId: chunks.documentId, ucId: chunks.ucId, version: documents.version })
      .from(chunks)
      .innerJoin(documents, eq(documents.id, chunks.documentId))
      .where(inArray(chunks.id, chunkIds));
    const docIds = [...new Set(origin.map((o) => o.documentId))];
    const ucIds = [...new Set(origin.map((o) => o.ucId).filter((u): u is string => Boolean(u)))];
    const versions = [...new Map(origin.map((o) => [o.documentId, o.version])).entries()].sort(([a], [b]) => a.localeCompare(b));

    // Candidate screenshots: every screen of the use cases involved.
    const candidateScreens = ucIds.length
      ? await db
          .select({ id: screens.id })
          .from(screens)
          .innerJoin(documents, eq(documents.id, screens.documentId))
          .where(and(inArray(screens.ucId, ucIds), sql`documents.deleted_at is null`))
      : [];

    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ q: input.cacheQuery.toLowerCase().trim(), steps: input.steps.map((s) => s.text), versions }))
      .digest("hex");
    const [existing] = await db
      .select({ id: videoJobs.id, status: videoJobs.status })
      .from(videoJobs)
      .where(and(eq(videoJobs.cacheKey, cacheKey), notInArray(videoJobs.status, ["failed", "stale"])))
      .orderBy(desc(videoJobs.createdAt))
      .limit(1);
    if (existing) {
      Object.assign(data, { cacheHit: true, jobId: existing.id, status: existing.status });
      return existing.id;
    }

    const jobInput: VideoJobInput = { question: input.question, audience: input.audience, steps: input.steps, screenIds: candidateScreens.map((s) => s.id) };
    const [job] = await db
      .insert(videoJobs)
      .values({ cacheKey, question: input.question, ucIds, sourceDocIds: docIds, input: jobInput as unknown as Record<string, unknown>, traceId: tracer.id })
      .returning({ id: videoJobs.id });
    await deps.enqueueVideo(job!.id);
    Object.assign(data, { cacheHit: false, jobId: job!.id, steps: input.steps.length, candidateScreens: candidateScreens.length });
    return job!.id;
  });
}
