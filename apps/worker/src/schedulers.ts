import { sources, type Db } from "@oa/db";
import type { CrawlQueue } from "./queue.js";

/**
 * Makes the BullMQ job schedulers match the sources table: one delta and one
 * full-reconciliation schedule per enabled source. Run on startup and after
 * any source change from the admin API.
 */
export async function syncSchedulers(db: Db, queue: CrawlQueue): Promise<void> {
  const rows = await db.select().from(sources);
  const wanted = new Set<string>();

  for (const s of rows.filter((r) => r.enabled)) {
    for (const [kind, pattern, trigger] of [
      ["delta", s.deltaCron, "schedule"],
      ["full", s.fullCron, "full"],
    ] as const) {
      const id = `${kind}:${s.id}`;
      wanted.add(id);
      await queue.upsertJobScheduler(id, { pattern }, { name: "crawl", data: { sourceId: s.id, trigger } });
    }
  }

  for (const existing of await queue.getJobSchedulers()) {
    if (existing.key && !wanted.has(existing.key)) await queue.removeJobScheduler(existing.key);
  }
}
