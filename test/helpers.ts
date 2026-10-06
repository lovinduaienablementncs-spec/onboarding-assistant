import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { AlignmentType, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from "docx";
import { EMBEDDING_DIM, type Db } from "@oa/db";
import * as schema from "@oa/db";
import type { BlobStore, ChangePage, Embedder, SourceConnector, SourceItem } from "@oa/ingestion";

/** In-process Postgres with pgvector, migrated with the real migration files. */
export async function createTestDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite({ extensions: { vector } });
  await client.exec("create extension if not exists vector");
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../packages/db/migrations", import.meta.url)) });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Deterministic embeddings; records every text it was asked to embed. */
export class FakeEmbedder implements Embedder {
  calls: string[][] = [];

  async embed(texts: string[]) {
    this.calls.push(texts);
    const vectors = texts.map((t) => {
      const h = createHash("sha256").update(t).digest();
      return Array.from({ length: EMBEDDING_DIM }, (_, i) => h[i % h.length]! / 255);
    });
    return { vectors, tokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0) };
  }

  get embeddedCount() {
    return this.calls.flat().length;
  }
}

export class MemoryBlobStore implements BlobStore {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) { this.files.set(key, data); }
  async get(key: string) { return this.files.get(key)!; }
  async delete(key: string) { this.files.delete(key); }
}

interface FakeFile { id: string; path: string; data: Buffer; version: number; acl: string[] }

/**
 * In-memory source that behaves like Graph delta: a change log, a cursor that
 * is a position in that log, and paging. Tests can make downloads fail or
 * make listing crash part-way through.
 */
export class FakeConnector implements SourceConnector {
  private files = new Map<string, FakeFile>();
  private log: SourceItem[] = [];
  failDownloads = new Set<string>();
  crashListingAfterPages: number | null = null;
  pageSize = 2;
  downloads = 0;

  put(id: string, path: string, data: Buffer, acl = ["group-staff"]) {
    const prev = this.files.get(id);
    const f = { id, path, data, acl, version: prev && prev.data.equals(data) ? prev.version : (prev?.version ?? 0) + 1 };
    this.files.set(id, f);
    this.log.push(this.toItem(f));
  }

  rename(id: string, newPath: string) {
    const f = this.files.get(id)!;
    f.path = newPath;
    this.log.push(this.toItem(f));
  }

  remove(id: string) {
    const f = this.files.get(id)!;
    this.files.delete(id);
    this.log.push({ ...this.toItem(f), deleted: true });
  }

  /** Removes a file without a delta record, as if a webhook and delta were missed. */
  vanish(id: string) {
    this.files.delete(id);
  }

  async *listChanges(cursor?: string | null): AsyncIterable<ChangePage> {
    const items = cursor == null
      ? [...this.files.values()].map((f) => this.toItem(f))
      : [...new Map(this.log.slice(Number(cursor)).map((i) => [i.externalId, i])).values()];
    const end = String(this.log.length);
    let pages = 0;
    for (let i = 0; i < items.length || i === 0; i += this.pageSize) {
      if (this.crashListingAfterPages !== null && pages >= this.crashListingAfterPages) throw new Error("Graph connection reset");
      const last = i + this.pageSize >= items.length;
      yield { items: items.slice(i, i + this.pageSize), nextCursor: last ? end : undefined };
      pages++;
      if (last) break;
    }
  }

  async download(id: string) {
    this.downloads++;
    if (this.failDownloads.has(id)) throw new Error(`download failed for ${id}`);
    return this.files.get(id)!.data;
  }

  async getAcl(id: string) {
    return this.files.get(id)?.acl ?? [];
  }

  private toItem(f: FakeFile): SourceItem {
    return {
      externalId: f.id,
      name: f.path.split("/").pop()!,
      path: f.path,
      webUrl: `https://contoso.sharepoint.com/sites/specs${encodeURI(f.path)}`,
      isFolder: false,
      deleted: false,
      cTag: `c:${f.id},${f.version}`,
    };
  }
}

// 1x1 PNGs in two colours, so screenshot hashes differ.
export const PNG_RED = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");
export const PNG_BLUE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function makeUcsDocx(o: { title: string; mainFlow: string[]; rules: string[] }): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: o.title, heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: "Overview", heading: HeadingLevel.HEADING_2 }),
          new Paragraph("Lets a submitter monitor the records of a submission batch."),
          new Paragraph({ text: "Main Flow", heading: HeadingLevel.HEADING_2 }),
          ...o.mainFlow.map((s, i) => new Paragraph(`${i + 1}. ${s}`)),
          new Paragraph({ text: "Business Rules", heading: HeadingLevel.HEADING_2 }),
          ...o.rules.map((r) => new Paragraph(r)),
          new Paragraph({ text: "Data Fields", heading: HeadingLevel.HEADING_2 }),
          new Table({
            rows: [
              new TableRow({ children: [new TableCell({ children: [new Paragraph("Field")] }), new TableCell({ children: [new Paragraph("Description")] })] }),
              new TableRow({ children: [new TableCell({ children: [new Paragraph("Pass Count")] }), new TableCell({ children: [new Paragraph("Records that passed validation")] })] }),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

export async function makeUisDocx(o: { title: string; screens: Array<{ name: string; text: string; image: Buffer }> }): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: o.title, heading: HeadingLevel.HEADING_1 }),
          ...o.screens.flatMap((s) => [
            new Paragraph({ text: s.name, heading: HeadingLevel.HEADING_2 }),
            new Paragraph(s.text),
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ type: "png", data: s.image, transformation: { width: 100, height: 60 } })],
            }),
          ]),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}
