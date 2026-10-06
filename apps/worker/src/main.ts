import Anthropic from "@anthropic-ai/sdk";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { ClaudeModels, loadSettings } from "@oa/agents";
import { createDb } from "@oa/db";
import { createConnector, LocalBlobStore, VoyageEmbedder } from "@oa/ingestion";
import { env } from "@oa/shared";
import { AzureTts, SilentTts } from "@oa/video";
import { reindexDocuments, runCrawl, type CrawlDeps } from "./crawl.js";
import { describeScreens, runVideoJob, type MediaDeps } from "./media.js";
import { createCrawlQueue, enqueue, QUEUE_NAME, type CrawlJob } from "./queue.js";
import { syncSchedulers } from "./schedulers.js";

const LOCK_TTL_MS = 3 * 60 * 60 * 1000;

const db = createDb();
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
const queue = createCrawlQueue(env.redisUrl);
const embedder = new VoyageEmbedder();
const blobs = new LocalBlobStore();
const settings = () => loadSettings(db);

const deps: CrawlDeps = { db, embedder, blobs, connectorFor: createConnector };

const media: MediaDeps = {
  db,
  blobs,
  embedder,
  settings,
  models: new ClaudeModels(new Anthropic(), async () => (await settings()).models),
  // Without a speech key, videos are rendered silent with on-screen captions.
  tts: env.speechKey && env.speechRegion ? new AzureTts(env.speechKey, env.speechRegion) : new SilentTts(),
};

const worker = new Worker<CrawlJob["data"]>(
  QUEUE_NAME,
  async (job) => {
    const j = { name: job.name, data: job.data } as CrawlJob;
    switch (j.name) {
      case "sync-schedulers":
        return syncSchedulers(db, queue);
      case "reindex":
        await reindexDocuments(deps, j.data.documentIds);
        await enqueue(queue, { name: "describe-screens", data: {} });
        return;
      case "describe-screens":
        if (!process.env.ANTHROPIC_API_KEY) return { skipped: "ANTHROPIC_API_KEY is not set" };
        return describeScreens(media);
      case "video":
        return runVideoJob(media, j.data.jobId);
      case "crawl": {
        // One active crawl per source. A trigger that arrives mid-run is dropped:
        // the change it signals is picked up by the next delta.
        const lockKey = `crawl-lock:${j.data.sourceId}`;
        if (!(await redis.set(lockKey, job.id ?? "1", "PX", LOCK_TTL_MS, "NX"))) {
          return { skipped: "crawl already running for this source" };
        }
        try {
          const summary = await runCrawl(deps, j.data.sourceId, j.data.trigger);
          // New or replaced screenshots need descriptions before they can be used in videos.
          await enqueue(queue, { name: "describe-screens", data: {} });
          return summary;
        } finally {
          await redis.del(lockKey);
        }
      }
    }
  },
  { connection: { url: env.redisUrl }, concurrency: 2 },
);

worker.on("failed", (job, err) => console.error(`job ${job?.name} ${job?.id} failed:`, err));
worker.on("completed", (job, result) => console.log(`job ${job.name} ${job.id} done`, result ?? ""));

await syncSchedulers(db, queue);
console.log(`worker started (speech: ${media.tts.voiced ? "Azure" : "silent captions"})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close();
    await queue.close();
    redis.disconnect();
    process.exit(0);
  });
}
