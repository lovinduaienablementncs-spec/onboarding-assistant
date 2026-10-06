import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { chunks, crawlItems, crawlRuns, documents, screens, sources, ucLinks, type Db } from "@oa/db";
import { SourceConfig } from "@oa/shared";
import {
  createTestDb,
  FakeConnector,
  FakeEmbedder,
  makeUcsDocx,
  makeUisDocx,
  MemoryBlobStore,
  PNG_BLUE,
  PNG_RED,
} from "../../../test/helpers.js";
import { PARSER_VERSION } from "@oa/ingestion";
import { runCrawl, type CrawlDeps } from "./crawl.js";

const FLOW = ["Open Submission Monitor", "Select a batch", "Click Reprocess on failed records"];
const RULES = ["BR1: Only failed records can be reprocessed."];

let db: Db;
let close: () => Promise<void>;
let connector: FakeConnector;
let embedder: FakeEmbedder;
let deps: CrawlDeps;
let sourceId: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  connector = new FakeConnector();
  embedder = new FakeEmbedder();
  deps = { db, embedder, blobs: new MemoryBlobStore(), connectorFor: () => connector, backoffMs: () => 0 };
  const [s] = await db
    .insert(sources)
    .values(SourceConfig.parse({ name: "Specs", connector: "onedrive", driveId: "drive-1", folderPath: "/Specs" }))
    .returning();
  sourceId = s!.id;

  connector.put("ucs-45", "/Specs/UCS/UC-045 Monitor Submissions.docx", await makeUcsDocx({ title: "UC-045 Monitor Submissions", mainFlow: FLOW, rules: RULES }));
  connector.put(
    "uis-45",
    "/Specs/UIS/UC-045 Monitor Submissions UI.docx",
    await makeUisDocx({
      title: "UC-045 UI",
      screens: [
        { name: "Submission Monitor", text: "Shows pass, fail and total counts.", image: PNG_RED },
        { name: "Reprocess Dialog", text: "Confirms reprocessing.", image: PNG_BLUE },
      ],
    }),
  );
  connector.put("outside", "/Other/UC-099 Notes.docx", await makeUcsDocx({ title: "UC-099", mainFlow: ["x"], rules: [] }));
});

afterEach(async () => close());

const liveDocs = () => db.select().from(documents).where(isNull(documents.deletedAt));
const docByExt = async (id: string) => (await db.select().from(documents).where(eq(documents.externalId, id)))[0]!;
const chunksOf = async (id: string) => db.select().from(chunks).where(eq(chunks.documentId, (await docByExt(id)).id));

describe("initial crawl", () => {
  it("indexes in-scope UCS and UIS documents, screenshots and links", async () => {
    const summary = await runCrawl(deps, sourceId, "schedule");

    expect(summary).toMatchObject({ added: 2, updated: 0, deleted: 0, failed: 0 });
    const docs = await liveDocs();
    expect(docs.map((d) => [d.ucId, d.docType, d.status]).sort()).toEqual([
      ["UC-045", "UCS", "indexed"],
      ["UC-045", "UIS", "indexed"],
    ]);
    expect((await chunksOf("ucs-45")).every((c) => c.embedding?.length === 1024)).toBe(true);
    expect(await db.select().from(screens)).toHaveLength(2);
    const links = await db.select().from(ucLinks);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ ucId: "UC-045", origin: "auto" });

    const [src] = await db.select().from(sources);
    expect(src!.deltaLink).toBeTruthy();
    const [run] = await db.select().from(crawlRuns);
    expect(run).toMatchObject({ status: "succeeded", added: 2, trigger: "schedule" });
  });
});

describe("delta sync", () => {
  beforeEach(async () => {
    await runCrawl(deps, sourceId, "schedule");
    embedder.calls = [];
    connector.downloads = 0;
  });

  it("does nothing when nothing changed", async () => {
    const s = await runCrawl(deps, sourceId, "schedule");
    expect(s).toMatchObject({ added: 0, updated: 0, deleted: 0 });
    expect(connector.downloads).toBe(0);
  });

  it("re-embeds only the changed chunk when a step is edited", async () => {
    const before = await chunksOf("ucs-45");
    connector.put(
      "ucs-45",
      "/Specs/UCS/UC-045 Monitor Submissions.docx",
      await makeUcsDocx({ title: "UC-045 Monitor Submissions", mainFlow: [...FLOW.slice(0, 2), "Click Retry on failed records"], rules: RULES }),
    );
    const s = await runCrawl(deps, sourceId, "schedule");

    expect(s.updated).toBe(1);
    expect(embedder.embeddedCount).toBe(1);
    const after = await chunksOf("ucs-45");
    expect(after).toHaveLength(before.length);
    expect(after.find((c) => c.section === "Main Flow")!.text).toContain("Click Retry on failed records");
    expect(after.some((c) => c.text.includes("Click Reprocess"))).toBe(false);
    expect((await docByExt("ucs-45")).version).toBe(2);
  });

  it("indexes a newly added use case and links it", async () => {
    connector.put("ucs-46", "/Specs/UCS/UC-046 Address Hierarchy.docx", await makeUcsDocx({ title: "UC-046", mainFlow: ["Add building"], rules: [] }));
    const s = await runCrawl(deps, sourceId, "schedule");
    expect(s.added).toBe(1);
    expect((await docByExt("ucs-46")).ucId).toBe("UC-046");
    expect(await db.select().from(ucLinks).where(eq(ucLinks.ucId, "UC-046"))).toHaveLength(1);
  });

  it("handles a rename inside scope without re-embedding", async () => {
    connector.rename("ucs-45", "/Specs/UCS/Renamed/UC-045 Monitor Submissions v2.docx");
    const s = await runCrawl(deps, sourceId, "schedule");

    expect(s).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    // Re-read once (the UC id may come from the new name), but every embedding is reused.
    expect(embedder.embeddedCount).toBe(0);
    expect(connector.downloads).toBe(1);
    expect((await docByExt("ucs-45")).path).toBe("/Specs/UCS/Renamed/UC-045 Monitor Submissions v2.docx");
    const items = await db.select().from(crawlItems).where(eq(crawlItems.action, "renamed"));
    expect(items).toHaveLength(1);
  });

  it("removes a deleted document from retrieval but keeps it for audit", async () => {
    connector.remove("ucs-45");
    const s = await runCrawl(deps, sourceId, "schedule");

    expect(s.deleted).toBe(1);
    const doc = await docByExt("ucs-45");
    expect(doc.status).toBe("deleted");
    expect(doc.deletedAt).not.toBeNull();
    expect(await chunksOf("ucs-45")).toHaveLength(0);
    // The UIS remains, now unlinked from any UCS.
    const links = await db.select().from(ucLinks).where(eq(ucLinks.ucId, "UC-045"));
    expect(links).toEqual([expect.objectContaining({ ucsDocumentId: null })]);
  });

  it("treats a move out of the configured folder as a delete", async () => {
    connector.rename("ucs-45", "/Archive/UC-045 Monitor Submissions.docx");
    expect((await runCrawl(deps, sourceId, "schedule")).deleted).toBe(1);
  });

  it("replaces a changed screenshot and keeps vision data for unchanged ones", async () => {
    const uis = await docByExt("uis-45");
    await db.update(screens).set({ description: { screenName: "Submission Monitor" }, verified: true }).where(eq(screens.documentId, uis.id));

    connector.put(
      "uis-45",
      "/Specs/UIS/UC-045 Monitor Submissions UI.docx",
      await makeUisDocx({
        title: "UC-045 UI",
        screens: [
          { name: "Submission Monitor", text: "Shows pass, fail and total counts.", image: PNG_RED },
          { name: "Reprocess Dialog", text: "Confirms reprocessing.", image: PNG_RED },
        ],
      }),
    );
    await runCrawl(deps, sourceId, "schedule");

    const rows = await db.select().from(screens).where(eq(screens.documentId, uis.id));
    expect(rows).toHaveLength(2);
    // Both now use the red image, whose description and verified flag were kept.
    expect(rows.every((r) => r.verified && r.description)).toBe(true);
  });
});

describe("failures and recovery", () => {
  it("dead-letters a file that keeps failing without stopping the run", async () => {
    connector.failDownloads.add("uis-45");
    const s = await runCrawl(deps, sourceId, "schedule");

    expect(s).toMatchObject({ added: 1, failed: 1 });
    const [dead] = await db.select().from(crawlItems).where(eq(crawlItems.status, "dead"));
    expect(dead).toMatchObject({ externalId: "uis-45", attempts: 5 });
    expect((await docByExt("uis-45")).status).toBe("failed");
    expect((await db.select().from(crawlRuns))[0]!.status).toBe("succeeded");

    // Once the file is readable, the nightly full crawl retries it.
    connector.failDownloads.clear();
    expect((await runCrawl(deps, sourceId, "full")).updated).toBe(1);
    expect((await docByExt("uis-45")).status).toBe("indexed");
  });

  it("does not advance the delta cursor when a run crashes, and re-running creates no duplicates", async () => {
    await runCrawl(deps, sourceId, "schedule");
    const [{ deltaLink: cursorBefore }] = (await db.select().from(sources)) as [{ deltaLink: string }];

    connector.put("ucs-46", "/Specs/UCS/UC-046 Address Hierarchy.docx", await makeUcsDocx({ title: "UC-046", mainFlow: ["Add building"], rules: [] }));
    connector.put("ucs-47", "/Specs/UCS/UC-047 Owners.docx", await makeUcsDocx({ title: "UC-047", mainFlow: ["Add owner"], rules: [] }));
    connector.put("ucs-48", "/Specs/UCS/UC-048 Valuation.docx", await makeUcsDocx({ title: "UC-048", mainFlow: ["Value it"], rules: [] }));
    connector.crashListingAfterPages = 1;

    await expect(runCrawl(deps, sourceId, "schedule")).rejects.toThrow("Graph connection reset");
    expect((await db.select().from(sources))[0]!.deltaLink).toBe(cursorBefore);
    const runs = await db.select().from(crawlRuns).where(eq(crawlRuns.status, "failed"));
    expect(runs).toHaveLength(1);

    connector.crashListingAfterPages = null;
    await runCrawl(deps, sourceId, "schedule");
    const docs = await liveDocs();
    expect(docs.map((d) => d.externalId).sort()).toEqual(["ucs-45", "ucs-46", "ucs-47", "ucs-48", "uis-45"]);
    const ucs46 = await chunksOf("ucs-46");
    expect(new Set(ucs46.map((c) => c.ordinal)).size).toBe(ucs46.length);
  });

  it("full reconciliation removes documents that vanished without a delta record", async () => {
    await runCrawl(deps, sourceId, "schedule");
    connector.vanish("uis-45");

    expect((await runCrawl(deps, sourceId, "schedule")).deleted).toBe(0);
    expect((await runCrawl(deps, sourceId, "full")).deleted).toBe(1);
    expect((await docByExt("uis-45")).status).toBe("deleted");
  });
});

describe("parser upgrades", () => {
  it("re-reads documents indexed by an older parser, reusing embeddings", async () => {
    await runCrawl(deps, sourceId, "schedule");
    await db.update(documents).set({ parserVersion: 1 }).where(eq(documents.externalId, "ucs-45"));
    embedder.calls = [];
    connector.downloads = 0;

    const s = await runCrawl(deps, sourceId, "schedule");
    expect(s.updated).toBe(1);
    expect(connector.downloads).toBe(1);
    expect(embedder.embeddedCount).toBe(0);
    expect((await docByExt("ucs-45")).parserVersion).toBe(PARSER_VERSION);
  });
});

describe("classification from content", () => {
  it("files a UI spec saved in the UCS folder as UIS", async () => {
    connector.put("misfiled", "/Specs/UCS/UC-050 Notices.docx", await makeUisDocx({ title: "UI Specification: Notices", screens: [] }));
    await runCrawl(deps, sourceId, "schedule");
    const doc = await docByExt("misfiled");
    expect(doc.docType).toBe("UIS");
    expect((await chunksOf("misfiled")).every((c) => c.docType === "UIS")).toBe(true);
  });

  it("finds the UC id in the document header when the file name has none", async () => {
    connector.put("no-id", "/Specs/UCS/Address Hierarchy.docx", await makeUcsDocx({ title: "UC-077 Address Hierarchy", mainFlow: ["Add"], rules: [] }));
    await runCrawl(deps, sourceId, "schedule");
    expect((await docByExt("no-id")).ucId).toBe("UC-077");
    // Re-running without changes keeps it and does no work.
    embedder.calls = [];
    const s = await runCrawl(deps, sourceId, "schedule");
    expect(s.updated).toBe(0);
    expect((await docByExt("no-id")).ucId).toBe("UC-077");
  });
});

describe("admin overrides", () => {
  it("keeps a manual UC id override across crawls", async () => {
    connector.put("odd", "/Specs/UCS/Address Hierarchy.docx", await makeUcsDocx({ title: "Address", mainFlow: ["Add"], rules: [] }));
    await runCrawl(deps, sourceId, "schedule");
    expect((await docByExt("odd")).ucId).toBeNull();

    await db.update(documents).set({ ucIdOverride: "UC-046", cTag: null }).where(eq(documents.externalId, "odd"));
    await runCrawl(deps, sourceId, "full");

    const doc = await docByExt("odd");
    expect(doc.ucId).toBe("UC-046");
    const docChunks = await db.select().from(chunks).where(and(eq(chunks.documentId, doc.id), eq(chunks.ucId, "UC-046")));
    expect(docChunks.length).toBeGreaterThan(0);
  });
});
