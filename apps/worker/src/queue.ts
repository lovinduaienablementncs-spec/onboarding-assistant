import { Queue } from "bullmq";
import type { CrawlTrigger } from "@oa/shared";

export const QUEUE_NAME = "crawl";

export type CrawlJob =
  | { name: "crawl"; data: { sourceId: string; trigger: CrawlTrigger } }
  | { name: "reindex"; data: { documentIds: string[] } }
  | { name: "sync-schedulers"; data: Record<string, never> }
  | { name: "describe-screens"; data: Record<string, never> }
  | { name: "video"; data: { jobId: string } };

export function createCrawlQueue(redisUrl: string) {
  return new Queue(QUEUE_NAME, {
    connection: { url: redisUrl },
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
}

export type CrawlQueue = ReturnType<typeof createCrawlQueue>;

export function enqueue(queue: CrawlQueue, job: CrawlJob) {
  return queue.add(job.name, job.data);
}
