import Anthropic from "@anthropic-ai/sdk";
import { ClaudeModels, loadSettings, Retriever, VoyageReranker } from "@oa/agents";
import { createDb } from "@oa/db";
import { createConnector, GraphDirectory, LocalBlobStore, VoyageEmbedder } from "@oa/ingestion";
import { env, Role } from "@oa/shared";
import { createCrawlQueue, enqueue } from "@oa/worker/queue";
import { devVerifier, entraVerifier } from "./auth.js";
import { buildServer } from "./server.js";

const devRoles = process.env.AUTH_DEV_ROLES;
if (devRoles && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_DEV_ROLES must not be set in production");
}

const db = createDb();
const queue = createCrawlQueue(env.redisUrl);
const settings = () => loadSettings(db);

const app = await buildServer({
  db,
  verify: devRoles
    ? devVerifier(devRoles.split(",").map((r) => Role.parse(r.trim())))
    : entraVerifier(env.tenantId, [env.apiAudience, env.clientId]),
  enqueue: (job) => enqueue(queue, job),
  connectorFor: createConnector,
  directory: new GraphDirectory(),
  blobs: new LocalBlobStore(),
  pipeline: {
    db,
    models: new ClaudeModels(new Anthropic(), async () => (await settings()).models),
    retriever: new Retriever(db, new VoyageEmbedder(), new VoyageReranker()),
    enqueueVideo: (jobId) => enqueue(queue, { name: "video", data: { jobId } }),
    settings,
  },
  publicConfig: devRoles
    ? { authMode: "dev" }
    : { authMode: "entra", tenantId: env.tenantId, clientId: env.clientId, apiScope: `${env.apiAudience}/access_as_user` },
});

if (devRoles) app.log.warn(`Auth bypass enabled for local development with roles: ${devRoles}`);
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 4000) });
