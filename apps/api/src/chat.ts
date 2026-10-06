import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { createVideoJob, handleQuestion, Tracer, type ChatEvent, type ChatUser, type VideoJobInput } from "@oa/agents";
import { conversations, feedback, messages, videoJobs } from "@oa/db";
import { requireRole, type AuthUser } from "./auth.js";
import type { ServerDeps } from "./server.js";

const anyUser = requireRole("Assistant.Admin", "Assistant.ContentReviewer", "Assistant.Developer", "Assistant.User");
const IdParam = z.object({ id: z.string().uuid() });

export function chatUser(u: AuthUser): ChatUser {
  const developer = u.roles.includes("Assistant.Developer") || u.roles.includes("Assistant.Admin");
  return {
    id: u.id,
    name: u.name,
    defaultAudience: developer ? "developer" : "end_user",
    // Security trimming is opt-in until document ACLs and token group claims are configured.
    principals: process.env.ACL_TRIMMING === "true" ? [u.id, ...(u.groups ?? [])] : undefined,
  };
}

export async function chatRoutes(app: FastifyInstance, deps: ServerDeps) {
  const { db } = deps;

  /** Streams progress and the final grounded answer as server-sent events. */
  app.post("/chat", { preHandler: anyUser }, async (req, reply) => {
    const body = z.object({ message: z.string().trim().min(1).max(2000), conversationId: z.string().uuid().optional() }).parse(req.body);
    if (body.conversationId) {
      const [c] = await db.select({ userId: conversations.userId }).from(conversations).where(eq(conversations.id, body.conversationId));
      if (!c || c.userId !== req.user!.id) return reply.code(404).send({ error: "Conversation not found" });
    }

    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (e: ChatEvent) => reply.raw.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    try {
      await handleQuestion(deps.pipeline, { question: body.message, conversationId: body.conversationId, user: chatUser(req.user!) }, send);
    } catch (err) {
      req.log.error(err);
    } finally {
      reply.raw.write("event: done\ndata: {}\n\n");
      reply.raw.end();
    }
  });

  app.get("/conversations", { preHandler: anyUser }, async (req) =>
    db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.userId, req.user!.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(100),
  );

  app.get("/conversations/:id", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [c] = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, req.user!.id)));
    if (!c) return reply.code(404).send({ error: "Not found" });
    const rows = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
    return {
      ...c,
      messages: rows.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        outcome: m.outcome,
        sources: m.payload?.sources ?? [],
        intent: m.payload?.intent,
        videoJobId: m.payload?.videoJobId,
        canMakeVideo: Boolean((m.payload?.steps as unknown[] | undefined)?.length),
        createdAt: m.createdAt,
      })),
    };
  });

  app.delete("/conversations/:id", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.userId, req.user!.id)));
    return reply.code(204).send();
  });

  app.post("/messages/:id/feedback", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z.object({ rating: z.union([z.literal(1), z.literal(-1)]), comment: z.string().max(1000).optional() }).parse(req.body);
    if (!(await ownMessage(deps, id, req.user!.id))) return reply.code(404).send({ error: "Not found" });
    await db.delete(feedback).where(and(eq(feedback.messageId, id), eq(feedback.userId, req.user!.id)));
    await db.insert(feedback).values({ messageId: id, userId: req.user!.id, rating: body.rating, comment: body.comment });
    return { ok: true };
  });

  /** "Generate a video guide" for an answer that was written as an explanation. */
  app.post("/messages/:id/video", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const msg = await ownMessage(deps, id, req.user!.id);
    if (!msg) return reply.code(404).send({ error: "Not found" });
    const steps = msg.payload?.steps as VideoJobInput["steps"] | undefined;
    if (!steps?.length) return reply.code(400).send({ error: "This answer has no verified steps to build a video from" });
    if (msg.payload?.videoJobId) return { jobId: msg.payload.videoJobId };

    const [question] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, msg.conversationId), eq(messages.role, "user")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const tracer = new Tracer(db, { kind: "video_request", conversationId: msg.conversationId, userId: req.user!.id, userName: req.user!.name, question: question?.content });
    const jobId = await createVideoJob(deps.pipeline, tracer, {
      question: question?.content ?? "Guide",
      cacheQuery: (msg.payload?.rewrittenQuery as string | undefined) ?? question?.content ?? "",
      audience: (msg.payload?.audience as "end_user" | "developer" | undefined) ?? "end_user",
      steps,
    });
    await tracer.finish("ok");
    await db.update(messages).set({ payload: { ...msg.payload, videoJobId: jobId } }).where(eq(messages.id, id));
    return { jobId };
  });

  app.get("/videos/:id", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [job] = await db
      .select({ id: videoJobs.id, status: videoJobs.status, durationSec: videoJobs.durationSec, hasVoice: videoJobs.hasVoice, error: videoJobs.error, question: videoJobs.question })
      .from(videoJobs)
      .where(eq(videoJobs.id, id));
    if (!job) return reply.code(404).send({ error: "Not found" });
    return { ...job, error: job.status === "failed" ? "The video could not be made for this answer." : null };
  });

  app.get("/videos/:id/file", { preHandler: anyUser }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [job] = await db.select({ blobKey: videoJobs.blobKey, status: videoJobs.status }).from(videoJobs).where(eq(videoJobs.id, id));
    if (!job?.blobKey || job.status !== "ready") return reply.code(404).send({ error: "Video not ready" });
    return reply.type("video/mp4").header("Cache-Control", "private, max-age=3600").send(await deps.blobs.get(job.blobKey));
  });
}

async function ownMessage(deps: ServerDeps, messageId: string, userId: string) {
  const [row] = await deps.db
    .select({ id: messages.id, conversationId: messages.conversationId, payload: messages.payload, owner: conversations.userId })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(eq(messages.id, messageId));
  return row && row.owner === userId ? row : undefined;
}
