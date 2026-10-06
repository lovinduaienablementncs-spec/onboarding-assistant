import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { chunks, documents, screens, ucLinks, videoJobs, type Db } from "@oa/db";
import type { DocType } from "@oa/shared";
import type { BlobStore } from "./blob.js";
import { chunkDocument, chunkHeader, sha256 } from "./chunker.js";
import { detectDocTypeFromContent, documentHeader, extractUcId } from "./classify.js";
import type { Embedder } from "./embeddings.js";
import { parseDocument } from "./parsers/index.js";

export interface IndexDeps {
  db: Db;
  embedder: Embedder;
  blobs: BlobStore;
}

export interface IndexTarget {
  id: string;
  name: string;
  /** UC id from the file path (or an admin override). */
  ucId: string | null;
  /** Type from the folder rules (or an admin override). */
  docType: DocType;
  /** When true (admin override), keep ucId / docType as given instead of reading the document. */
  lockUcId?: boolean;
  lockDocType?: boolean;
  /** Used to find a UC id in the document header when the path has none. */
  ucIdPattern?: string;
}

export interface IndexResult {
  ucId: string | null;
  docType: DocType;
  chunks: number;
  reusedChunks: number;
  screens: number;
  embeddingTokens: number;
}

/**
 * Bump whenever parsing, chunking or classification changes the output, so
 * every document is re-read once on the next crawl. History:
 * 1 initial; 2 bold numbered headings, cell line breaks, footers, content-based type.
 */
export const PARSER_VERSION = 2;

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/bmp": "bmp" };

/**
 * Parses, chunks and embeds one document, then swaps its chunks and screens
 * in a single transaction. Unchanged chunks keep their embeddings and
 * unchanged screenshots keep their vision description and verified boxes.
 *
 * The final type is what the document header says it is (falling back to the
 * folder rules), and the UC id comes from the path, falling back to the header.
 */
export async function indexDocument(deps: IndexDeps, target: IndexTarget, data: Buffer): Promise<IndexResult> {
  const { db, embedder, blobs } = deps;
  const parsed = await parseDocument(target.name, data);
  const docType = target.lockDocType ? target.docType : (detectDocTypeFromContent(parsed) ?? target.docType);
  const ucId =
    target.lockUcId || target.ucId || !target.ucIdPattern
      ? target.ucId
      : extractUcId(documentHeader(parsed), target.ucIdPattern);
  const drafts = chunkDocument(parsed, ucId, docType);

  const existing = await db
    .select({ textHash: chunks.textHash, embedding: chunks.embedding })
    .from(chunks)
    .where(eq(chunks.documentId, target.id));
  const known = new Map(existing.filter((c) => c.embedding).map((c) => [c.textHash, c.embedding!]));

  const toEmbed = drafts.filter((d) => !known.has(d.textHash));
  const { vectors, tokens } = toEmbed.length
    ? await embedder.embed(toEmbed.map((d) => `${chunkHeader(d)}\n${d.text}`), "document")
    : { vectors: [], tokens: 0 };
  toEmbed.forEach((d, i) => known.set(d.textHash, vectors[i]!));

  const oldScreens = new Map(
    (await db.select().from(screens).where(eq(screens.documentId, target.id))).map((s) => [s.imageHash, s]),
  );
  const screenRows: (typeof screens.$inferInsert)[] = [];
  for (const section of parsed.sections) {
    for (const img of section.images) {
      const imageHash = sha256(img.data);
      const prev = oldScreens.get(imageHash);
      const blobKey = prev?.blobKey ?? `screens/${imageHash}.${EXT[img.contentType] ?? "bin"}`;
      if (!prev) await blobs.put(blobKey, img.data, img.contentType);
      screenRows.push({
        documentId: target.id,
        ucId,
        ordinal: screenRows.length,
        imageHash,
        blobKey,
        contentType: img.contentType,
        caption: [section.headingPath.at(-1), img.caption].filter(Boolean).join(" — ") || null,
        context: section.text.slice(0, 3000),
        description: prev?.description,
        embedding: prev?.embedding,
        verified: prev?.verified ?? false,
      });
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, target.id));
    if (drafts.length) {
      await tx.insert(chunks).values(
        drafts.map((d) => ({
          documentId: target.id,
          ucId: d.ucId,
          docType: d.docType,
          section: d.section,
          headingPath: d.headingPath,
          ordinal: d.ordinal,
          text: d.text,
          textHash: d.textHash,
          embedding: known.get(d.textHash),
        })),
      );
    }
    await tx.delete(screens).where(eq(screens.documentId, target.id));
    if (screenRows.length) await tx.insert(screens).values(screenRows);
    await tx
      .update(documents)
      .set({
        ucId,
        docType,
        parserVersion: PARSER_VERSION,
        contentHash: sha256(data),
        version: sql`${documents.version} + 1`,
        status: "indexed",
        lastIndexedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, target.id));
    if (ucId) await rebuildUcLinks(tx, ucId);
    // Videos built from the old version of this document must be re-made.
    await tx
      .update(videoJobs)
      .set({ status: "stale" })
      .where(and(sql`video_jobs.source_doc_ids ? ${target.id}`, inArray(videoJobs.status, ["queued", "storyboard", "rendering", "ready"])));
  });

  return {
    ucId,
    docType,
    chunks: drafts.length,
    reusedChunks: drafts.length - toEmbed.length,
    screens: screenRows.length,
    embeddingTokens: tokens,
  };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Recreates the automatic UCS <-> UIS links for a use case. Manual (admin) links are kept. */
export async function rebuildUcLinks(tx: Tx | Db, ucId: string): Promise<void> {
  const docs = await tx
    .select({ id: documents.id, docType: documents.docType })
    .from(documents)
    .where(and(eq(documents.ucId, ucId), isNull(documents.deletedAt), inArray(documents.docType, ["UCS", "UIS"])));
  const ucs = docs.filter((d) => d.docType === "UCS").map((d) => d.id);
  const uis = docs.filter((d) => d.docType === "UIS").map((d) => d.id);

  await tx.delete(ucLinks).where(and(eq(ucLinks.ucId, ucId), eq(ucLinks.origin, "auto")));
  const rows = ucs.length && uis.length
    ? ucs.flatMap((u) => uis.map((i) => ({ ucId, ucsDocumentId: u, uisDocumentId: i })))
    : [...ucs.map((u) => ({ ucId, ucsDocumentId: u })), ...uis.map((i) => ({ ucId, uisDocumentId: i }))];
  if (rows.length) await tx.insert(ucLinks).values(rows).onConflictDoNothing();
}
