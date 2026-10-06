import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { auditLog, chunks, crawlItems, crawlRuns, documents, screens, sources, ucLinks } from "@oa/db";
import { classifyDocType, extractUcId, inScope } from "@oa/ingestion";
import { DocType, SourceConfig } from "@oa/shared";
import { audit } from "./audit.js";
import { requireRole } from "./auth.js";
import type { ServerDeps } from "./server.js";

const admin = requireRole("Assistant.Admin");
const reviewer = requireRole("Assistant.Admin", "Assistant.ContentReviewer");

const IdParam = z.object({ id: z.string().uuid() });
const Paging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Secrets are read from Key Vault / env; the API only ever reports whether each is set. */
const SECRET_NAMES = ["AZURE_CLIENT_SECRET", "VOYAGE_API_KEY", "ANTHROPIC_API_KEY", "AZURE_SPEECH_KEY", "DATABASE_URL"];

/** Hides internal sync state from API responses. */
function publicSource(s: typeof sources.$inferSelect) {
  const { deltaLink, webhookSubscriptionId, ...rest } = s;
  return { ...rest, hasDeltaLink: Boolean(deltaLink), webhookActive: Boolean(webhookSubscriptionId) };
}

export async function adminRoutes(app: FastifyInstance, deps: ServerDeps) {
  const { db, enqueue } = deps;

  // ---- Sources ----
  app.get("/sources", { preHandler: reviewer }, async () => {
    const rows = await db.select().from(sources).orderBy(asc(sources.name));
    return rows.map(publicSource);
  });

  app.get("/sources/:id", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [row] = await db.select().from(sources).where(eq(sources.id, id));
    return row ? publicSource(row) : reply.code(404).send({ error: "Not found" });
  });

  app.post("/sources", { preHandler: admin }, async (req, reply) => {
    const cfg = SourceConfig.parse(req.body);
    const [row] = await db.insert(sources).values(cfg).returning();
    await audit(db, req, "create", "source", row!.id, null, cfg);
    await enqueue({ name: "sync-schedulers", data: {} });
    await enqueue({ name: "crawl", data: { sourceId: row!.id, trigger: "full" } });
    return reply.code(201).send(publicSource(row!));
  });

  app.patch("/sources/:id", { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const patch = SourceConfig.partial().parse(req.body);
    const [before] = await db.select().from(sources).where(eq(sources.id, id));
    if (!before) return reply.code(404).send({ error: "Not found" });
    // A new location or new rules means the stored delta no longer matches; force a full crawl.
    const scopeChanged = (["driveId", "folderPath", "includeGlobs", "excludeGlobs", "fileTypes", "ucIdPattern", "docTypeRules"] as const).some(
      (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(before[k]),
    );
    const rulesChanged = (["ucIdPattern", "docTypeRules"] as const).some(
      (k) => k in patch && JSON.stringify(patch[k]) !== JSON.stringify(before[k]),
    );
    const [row] = await db
      .update(sources)
      .set({ ...patch, ...(scopeChanged ? { deltaLink: null } : {}), updatedAt: new Date() })
      .where(eq(sources.id, id))
      .returning();
    // New classification rules: make the full crawl re-read every file (unchanged text keeps its embeddings).
    if (rulesChanged) await db.update(documents).set({ cTag: null }).where(eq(documents.sourceId, id));
    await audit(db, req, "update", "source", id, publicSource(before), publicSource(row!));
    await enqueue({ name: "sync-schedulers", data: {} });
    if (scopeChanged) await enqueue({ name: "crawl", data: { sourceId: id, trigger: "full" } });
    return publicSource(row!);
  });

  app.delete("/sources/:id", { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [before] = await db.delete(sources).where(eq(sources.id, id)).returning();
    if (!before) return reply.code(404).send({ error: "Not found" });
    await audit(db, req, "delete", "source", id, publicSource(before), null);
    await enqueue({ name: "sync-schedulers", data: {} });
    return reply.code(204).send();
  });

  for (const [path, enabled] of [["pause", false], ["resume", true]] as const) {
    app.post(`/sources/:id/${path}`, { preHandler: admin }, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const [row] = await db.update(sources).set({ enabled, updatedAt: new Date() }).where(eq(sources.id, id)).returning();
      if (!row) return reply.code(404).send({ error: "Not found" });
      await audit(db, req, path, "source", id, { enabled: !enabled }, { enabled });
      await enqueue({ name: "sync-schedulers", data: {} });
      return publicSource(row);
    });
  }

  app.post("/sources/:id/sync", { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { mode } = z.object({ mode: z.enum(["delta", "full"]).default("delta") }).parse(req.body ?? {});
    const [row] = await db.select({ id: sources.id }).from(sources).where(eq(sources.id, id));
    if (!row) return reply.code(404).send({ error: "Not found" });
    await enqueue({ name: "crawl", data: { sourceId: id, trigger: mode === "full" ? "full" : "manual" } });
    await audit(db, req, `sync-${mode}`, "source", id);
    return reply.code(202).send({ queued: true });
  });

  /** Dry run for the "add source" wizard: which files would be indexed and how they'd be classified. */
  app.post("/sources/preview", { preHandler: admin }, async (req) => {
    const cfg = SourceConfig.parse(req.body);
    const connector = deps.connectorFor(cfg);
    const files: Array<{ path: string; ucId: string | null; docType: string; webUrl: string }> = [];
    let scanned = 0;
    for await (const page of connector.listChanges(null)) {
      for (const item of page.items) {
        scanned++;
        if (!item.deleted && inScope(item, cfg)) {
          files.push({ path: item.path, webUrl: item.webUrl, ucId: extractUcId(item.path, cfg.ucIdPattern), docType: classifyDocType(item.path, cfg.docTypeRules) });
        }
      }
      if (scanned >= 5000) break;
    }
    return { scanned, matched: files.length, missingUcId: files.filter((f) => !f.ucId).length, files: files.slice(0, 500) };
  });

  // ---- SharePoint / OneDrive browser for the wizard ----
  app.get("/graph/sites", { preHandler: admin }, async (req) => {
    const { q } = z.object({ q: z.string().default("") }).parse(req.query);
    return deps.directory.searchSites(q);
  });
  app.get("/graph/sites/:siteId/drives", { preHandler: admin }, async (req) => {
    const { siteId } = z.object({ siteId: z.string().min(1) }).parse(req.params);
    return deps.directory.listDrives(siteId);
  });
  app.get("/graph/drives/:driveId/folders", { preHandler: admin }, async (req) => {
    const { driveId } = z.object({ driveId: z.string().min(1) }).parse(req.params);
    const { path } = z.object({ path: z.string().default("/") }).parse(req.query);
    return deps.directory.listFolders(driveId, path);
  });

  // ---- Crawl jobs ----
  app.get("/crawl-runs", { preHandler: reviewer }, async (req) => {
    const q = Paging.extend({ sourceId: z.string().uuid().optional() }).parse(req.query);
    return db
      .select()
      .from(crawlRuns)
      .where(q.sourceId ? eq(crawlRuns.sourceId, q.sourceId) : undefined)
      .orderBy(desc(crawlRuns.startedAt))
      .limit(q.limit)
      .offset(q.offset);
  });

  app.get("/crawl-runs/:id/items", { preHandler: reviewer }, async (req) => {
    const { id } = IdParam.parse(req.params);
    const q = Paging.extend({ status: z.enum(["ok", "dead"]).optional() }).parse(req.query);
    return db
      .select()
      .from(crawlItems)
      .where(and(eq(crawlItems.runId, id), q.status ? eq(crawlItems.status, q.status) : undefined))
      .orderBy(asc(crawlItems.createdAt))
      .limit(q.limit)
      .offset(q.offset);
  });

  app.post("/crawl-runs/:id/retry-failed", { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [run] = await db.select().from(crawlRuns).where(eq(crawlRuns.id, id));
    if (!run) return reply.code(404).send({ error: "Not found" });
    const dead = await db
      .select({ externalId: crawlItems.externalId })
      .from(crawlItems)
      .where(and(eq(crawlItems.runId, id), eq(crawlItems.status, "dead")));
    if (!dead.length) return { queued: 0 };
    const docs = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.sourceId, run.sourceId), inArray(documents.externalId, dead.map((d) => d.externalId))));
    await enqueue({ name: "reindex", data: { documentIds: docs.map((d) => d.id) } });
    await audit(db, req, "retry-failed", "crawl_run", id, null, { documents: docs.length });
    return reply.code(202).send({ queued: docs.length });
  });

  // ---- Documents ----
  app.get("/documents", { preHandler: reviewer }, async (req) => {
    const q = Paging.extend({
      q: z.string().optional(),
      ucId: z.string().optional(),
      docType: DocType.optional(),
      status: z.enum(["pending", "indexed", "failed", "deleted"]).optional(),
      sourceId: z.string().uuid().optional(),
    }).parse(req.query);
    const filters: (SQL | undefined)[] = [
      q.status ? eq(documents.status, q.status) : isNull(documents.deletedAt),
      q.ucId ? eq(documents.ucId, q.ucId.toUpperCase()) : undefined,
      q.docType ? eq(documents.docType, q.docType) : undefined,
      q.sourceId ? eq(documents.sourceId, q.sourceId) : undefined,
      q.q ? or(ilike(documents.name, `%${q.q}%`), ilike(documents.path, `%${q.q}%`), ilike(documents.ucId, `%${q.q}%`)) : undefined,
    ];
    const where = and(...filters);
    const [rows, [{ total } = { total: 0 }]] = await Promise.all([
      db
        .select({
          id: documents.id,
          sourceId: documents.sourceId,
          name: documents.name,
          path: documents.path,
          webUrl: documents.webUrl,
          ucId: documents.ucId,
          docType: documents.docType,
          version: documents.version,
          status: documents.status,
          lastIndexedAt: documents.lastIndexedAt,
          lastError: documents.lastError,
          // Fully qualified: drizzle renders bare column names inside sql``, which would bind to the subquery's own table.
          chunkCount: sql<number>`(select count(*)::int from chunks where chunks.document_id = documents.id)`,
          screenCount: sql<number>`(select count(*)::int from screens where screens.document_id = documents.id)`,
        })
        .from(documents)
        .where(where)
        .orderBy(asc(documents.ucId), asc(documents.name))
        .limit(q.limit)
        .offset(q.offset),
      db.select({ total: sql<number>`count(*)::int` }).from(documents).where(where),
    ]);
    return { total, items: rows };
  });

  app.get("/documents/:id", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [doc] = await db.select().from(documents).where(eq(documents.id, id));
    if (!doc) return reply.code(404).send({ error: "Not found" });
    const [docChunks, docScreens, links] = await Promise.all([
      db
        .select({ id: chunks.id, section: chunks.section, headingPath: chunks.headingPath, ordinal: chunks.ordinal, text: chunks.text })
        .from(chunks)
        .where(eq(chunks.documentId, id))
        .orderBy(asc(chunks.ordinal)),
      db
        .select({ id: screens.id, ordinal: screens.ordinal, caption: screens.caption, description: screens.description, verified: screens.verified })
        .from(screens)
        .where(eq(screens.documentId, id))
        .orderBy(asc(screens.ordinal)),
      doc.ucId ? db.select().from(ucLinks).where(eq(ucLinks.ucId, doc.ucId)) : Promise.resolve([]),
    ]);
    const { acl, ...rest } = doc;
    return { ...rest, aclCount: acl.length, chunks: docChunks, screens: docScreens, links };
  });

  /** Corrects a wrongly detected UC id or type. The crawler keeps the override from then on. */
  app.patch("/documents/:id", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const body = z
      .object({ ucIdOverride: z.string().regex(/^UC-\d{3,4}$/).nullable().optional(), docTypeOverride: DocType.nullable().optional() })
      .parse(req.body);
    const [before] = await db.select().from(documents).where(eq(documents.id, id));
    if (!before) return reply.code(404).send({ error: "Not found" });
    const [row] = await db
      .update(documents)
      .set({
        ...body,
        // cTag reset makes the next crawl re-index with the corrected identity.
        cTag: null,
        ...(body.ucIdOverride ? { ucId: body.ucIdOverride } : {}),
        ...(body.docTypeOverride ? { docType: body.docTypeOverride } : {}),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, id))
      .returning();
    await audit(db, req, "override", "document", id, { ucId: before.ucId, docType: before.docType }, body);
    await enqueue({ name: "reindex", data: { documentIds: [id] } });
    return { id: row!.id, ucId: row!.ucId, docType: row!.docType };
  });

  app.post("/documents/:id/reindex", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    await enqueue({ name: "reindex", data: { documentIds: [id] } });
    await audit(db, req, "reindex", "document", id);
    return reply.code(202).send({ queued: true });
  });

  app.get("/screens/:id/image", { preHandler: reviewer }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [s] = await db.select({ blobKey: screens.blobKey, contentType: screens.contentType }).from(screens).where(eq(screens.id, id));
    if (!s) return reply.code(404).send({ error: "Not found" });
    return reply.type(s.contentType).send(await deps.blobs.get(s.blobKey));
  });

  // ---- Secrets status & audit ----
  app.get("/secrets/status", { preHandler: admin }, async () =>
    SECRET_NAMES.map((name) => ({ name, set: Boolean(process.env[name]) })),
  );

  app.get("/audit-log", { preHandler: admin }, async (req) => {
    const q = Paging.parse(req.query);
    return db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(q.limit).offset(q.offset);
  });
}
