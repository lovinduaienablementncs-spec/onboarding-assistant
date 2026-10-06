import { and, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { chunks, crawlItems, crawlRuns, documents, screens, sources } from "@oa/db";
import {
  classifyDocType,
  extractUcId,
  inScope,
  PARSER_VERSION,
  indexDocument,
  rebuildUcLinks,
  type IndexDeps,
  type SourceConnector,
  type SourceItem,
} from "@oa/ingestion";
import type { CrawlTrigger, DocType } from "@oa/shared";

type Source = typeof sources.$inferSelect;
type Document = typeof documents.$inferSelect;

export interface CrawlDeps extends IndexDeps {
  connectorFor(source: Source): SourceConnector;
  /** Delay before retry n (1-based). Tests pass () => 0. */
  backoffMs?(attempt: number): number;
}

export interface CrawlSummary {
  runId: string;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failed: number;
  embeddingTokens: number;
}

const MAX_ATTEMPTS = 5;
/** Documents from an older parser version re-read per run. */
const STALE_BATCH = 50;

/**
 * Brings the index for one source in line with the source.
 * - delta (default): only changes since the stored deltaLink
 * - full: lists everything, then soft-deletes indexed documents that no longer exist
 * The deltaLink is only advanced when the whole run succeeds, so a crash
 * replays the same changes next time; every step is idempotent.
 */
export async function runCrawl(deps: CrawlDeps, sourceId: string, trigger: CrawlTrigger): Promise<CrawlSummary> {
  const { db } = deps;
  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!source) throw new Error(`Source ${sourceId} not found`);

  const [run] = await db.insert(crawlRuns).values({ sourceId, trigger }).returning({ id: crawlRuns.id });
  const summary: CrawlSummary = { runId: run!.id, added: 0, updated: 0, deleted: 0, unchanged: 0, failed: 0, embeddingTokens: 0 };
  const full = trigger === "full" || !source.deltaLink;
  const seen = new Set<string>();
  const connector = deps.connectorFor(source);

  try {
    let cursor: string | undefined;
    for await (const page of connector.listChanges(full ? null : source.deltaLink)) {
      for (const item of page.items) await processItem(deps, connector, source, run!.id, item, summary, seen);
      if (page.nextCursor) cursor = page.nextCursor;
    }

    // Documents read by an older parser are not in a delta (the file didn't change), so
    // revisit them here, a batch per run to spread the cost over a few runs.
    const stale = await db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.sourceId, sourceId),
          isNull(documents.deletedAt),
          lt(documents.parserVersion, PARSER_VERSION),
          // Skip anything this run already handled (including files that just failed).
          seen.size ? notInArray(documents.externalId, [...seen]) : undefined,
        ),
      )
      .limit(STALE_BATCH);
    for (const doc of stale) {
      const item: SourceItem = { externalId: doc.externalId, name: doc.name, path: doc.path, webUrl: doc.webUrl, isFolder: false, deleted: false, cTag: doc.cTag ?? undefined };
      await processItem(deps, connector, source, run!.id, item, summary, seen);
    }

    if (full) {
      const gone = await db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.sourceId, sourceId),
            isNull(documents.deletedAt),
            seen.size ? notInArray(documents.externalId, [...seen]) : undefined,
          ),
        );
      for (const doc of gone) {
        await softDelete(deps, doc);
        await logItem(deps, run!.id, doc.externalId, doc.path, "deleted", "ok");
        summary.deleted++;
      }
    }

    await db.update(sources).set({ deltaLink: cursor ?? source.deltaLink, updatedAt: new Date() }).where(eq(sources.id, sourceId));
    await db
      .update(crawlRuns)
      .set({ status: "succeeded", finishedAt: new Date(), ...counts(summary) })
      .where(eq(crawlRuns.id, run!.id));
    return summary;
  } catch (err) {
    await db
      .update(crawlRuns)
      .set({ status: "failed", finishedAt: new Date(), error: String(err), ...counts(summary) })
      .where(eq(crawlRuns.id, run!.id));
    throw err;
  }
}

async function processItem(
  deps: CrawlDeps,
  connector: SourceConnector,
  source: Source,
  runId: string,
  item: SourceItem,
  summary: CrawlSummary,
  seen: Set<string>,
) {
  const { db } = deps;
  const [existing] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.sourceId, source.id), eq(documents.externalId, item.externalId)));
  const live = existing && !existing.deletedAt ? existing : undefined;

  // Deleted, or moved/renamed out of the configured folder or file types.
  if (item.deleted || !inScope(item, source)) {
    if (live) {
      await softDelete(deps, live);
      await logItem(deps, runId, item.externalId, live.path, "deleted", "ok");
      summary.deleted++;
    }
    return;
  }
  seen.add(item.externalId);

  const sameContent = live?.status === "indexed" && live.cTag === item.cTag && live.parserVersion === PARSER_VERSION;

  if (live && sameContent && live.path === item.path) {
    // Nothing changed except possibly permissions.
    const acl = await connector.getAcl(item.externalId);
    await db.update(documents).set({ webUrl: item.webUrl, acl, updatedAt: new Date() }).where(eq(documents.id, live.id));
    summary.unchanged++;
    return;
  }

  // Hints from the path; indexDocument refines them from the document header unless an admin locked them.
  const lockUcId = Boolean(existing?.ucIdOverride);
  const lockDocType = Boolean(existing?.docTypeOverride);
  const ucId = existing?.ucIdOverride ?? extractUcId(item.path, source.ucIdPattern);
  const docType = (existing?.docTypeOverride as DocType | null) ?? classifyDocType(item.path, source.docTypeRules);

  const [doc] = await db
    .insert(documents)
    .values({ sourceId: source.id, externalId: item.externalId, path: item.path, name: item.name, webUrl: item.webUrl, ucId, docType })
    .onConflictDoUpdate({
      target: [documents.sourceId, documents.externalId],
      set: { path: item.path, name: item.name, webUrl: item.webUrl, ucId, docType, deletedAt: null, status: "pending", updatedAt: new Date() },
    })
    .returning();
  // A rename re-reads the file (the UC id may come from the new name) but reuses all embeddings.
  const action = !live ? "added" : sameContent ? "renamed" : "updated";

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const data = await connector.download(item.externalId);
      const acl = await connector.getAcl(item.externalId);
      const result = await indexDocument(
        deps,
        { id: doc!.id, name: item.name, ucId, docType, lockUcId, lockDocType, ucIdPattern: source.ucIdPattern },
        data,
      );
      // cTag is written only after a successful index, so failures are retried next run.
      await db.update(documents).set({ cTag: item.cTag, acl }).where(eq(documents.id, doc!.id));
      if (live?.ucId && live.ucId !== result.ucId) await rebuildUcLinks(db, live.ucId);
      summary.embeddingTokens += result.embeddingTokens;
      summary[action === "renamed" ? "unchanged" : action]++;
      await logItem(deps, runId, item.externalId, item.path, action, "ok", attempt);
      return;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, deps.backoffMs?.(attempt) ?? 2 ** attempt * 1000));
        continue;
      }
      // One bad file must not stop the run: record it as dead-lettered and move on.
      await db.update(documents).set({ status: "failed", lastError: String(err) }).where(eq(documents.id, doc!.id));
      await logItem(deps, runId, item.externalId, item.path, action, "dead", attempt, String(err));
      summary.failed++;
      return;
    }
  }
}

/** Removes a document from retrieval but keeps its row for audit. */
async function softDelete({ db }: CrawlDeps, doc: Document) {
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, doc.id));
    await tx.delete(screens).where(eq(screens.documentId, doc.id));
    await tx
      .update(documents)
      .set({ deletedAt: new Date(), status: "deleted", cTag: null, updatedAt: new Date() })
      .where(eq(documents.id, doc.id));
    if (doc.ucId) await rebuildUcLinks(tx, doc.ucId);
  });
}

/**
 * Re-indexes specific documents (admin "Re-index" and "Retry failed items").
 * A document left in "failed" status is retried by the next crawl that sees it,
 * because only "indexed" documents are skipped as unchanged.
 */
export async function reindexDocuments(deps: CrawlDeps, documentIds: string[]): Promise<void> {
  const { db } = deps;
  const docs = await db.select().from(documents).where(and(inArray(documents.id, documentIds), isNull(documents.deletedAt)));
  for (const doc of docs) {
    const [source] = await db.select().from(sources).where(eq(sources.id, doc.sourceId));
    const connector = deps.connectorFor(source!);
    try {
      const data = await connector.download(doc.externalId);
      const result = await indexDocument(
        deps,
        {
          id: doc.id,
          name: doc.name,
          ucId: doc.ucIdOverride ?? extractUcId(doc.path, source!.ucIdPattern),
          docType: (doc.docTypeOverride as DocType | null) ?? classifyDocType(doc.path, source!.docTypeRules),
          lockUcId: Boolean(doc.ucIdOverride),
          lockDocType: Boolean(doc.docTypeOverride),
          ucIdPattern: source!.ucIdPattern,
        },
        data,
      );
      if (doc.ucId && doc.ucId !== result.ucId) await rebuildUcLinks(db, doc.ucId);
    } catch (err) {
      await db.update(documents).set({ status: "failed", lastError: String(err) }).where(eq(documents.id, doc.id));
    }
  }
}

async function logItem(
  { db }: CrawlDeps,
  runId: string,
  externalId: string,
  path: string,
  action: string,
  status: "ok" | "dead",
  attempts = 1,
  error?: string,
) {
  await db.insert(crawlItems).values({ runId, externalId, path, action, status, attempts, error });
}

function counts(s: CrawlSummary) {
  const { added, updated, deleted, unchanged, failed, embeddingTokens } = s;
  return { added, updated, deleted, unchanged, failed, embeddingTokens };
}
