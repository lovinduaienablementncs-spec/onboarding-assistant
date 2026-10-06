import Fastify from "fastify";
import { ZodError } from "zod";
import type { Db } from "@oa/db";
import type { BlobStore, GraphDirectory, SourceConnector } from "@oa/ingestion";
import type { CrawlJob } from "@oa/worker/queue";
import type { PipelineDeps } from "@oa/agents";
import { adminAiRoutes } from "./admin-ai.js";
import { adminRoutes } from "./admin.js";
import { authenticate, type TokenVerifier } from "./auth.js";
import { chatRoutes } from "./chat.js";

export interface ServerDeps {
  db: Db;
  verify: TokenVerifier;
  enqueue(job: CrawlJob): Promise<unknown>;
  connectorFor(source: { connector: string; driveId: string }): SourceConnector;
  directory: Pick<GraphDirectory, "searchSites" | "listDrives" | "listFolders">;
  blobs: BlobStore;
  pipeline: PipelineDeps;
  /** Non-secret sign-in settings for the web app. */
  publicConfig: { authMode: "dev" | "entra"; tenantId?: string; clientId?: string; apiScope?: string };
}

export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: err.issues });
    app.log.error(err);
    const { statusCode = 500, message } = err as { statusCode?: number; message?: string };
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal error" : message });
  });

  app.get("/health", async () => ({ ok: true }));
  app.get("/config", async () => deps.publicConfig);

  await app.register(async (secured) => {
    secured.addHook("preHandler", authenticate(deps.verify));
    secured.get("/me", async (req) => req.user);
    await secured.register((chatApp) => chatRoutes(chatApp, deps));
    await secured.register((adminApp) => adminRoutes(adminApp, deps), { prefix: "/admin" });
    await secured.register((adminApp) => adminAiRoutes(adminApp, deps), { prefix: "/admin" });
  });

  return app;
}
