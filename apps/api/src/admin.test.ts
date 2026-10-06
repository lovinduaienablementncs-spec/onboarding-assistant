import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditLog, chunks, documents, sources, type Db } from "@oa/db";
import type { Role } from "@oa/shared";
import type { CrawlJob } from "@oa/worker/queue";
import { createTestDb, FakeConnector, MemoryBlobStore } from "../../../test/helpers.js";
import type { AuthUser } from "./auth.js";
import { buildServer } from "./server.js";

const USERS: Record<string, AuthUser> = {
  admin: { id: "u-admin", name: "Admin", roles: ["Assistant.Admin"] },
  reviewer: { id: "u-rev", name: "Reviewer", roles: ["Assistant.ContentReviewer"] },
  user: { id: "u-user", name: "User", roles: ["Assistant.User"] },
};

let db: Db;
let close: () => Promise<void>;
let jobs: CrawlJob[];
let app: Awaited<ReturnType<typeof buildServer>>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  jobs = [];
  const connector = new FakeConnector();
  connector.put("a", "/Specs/UCS/UC-045 Monitor.docx", Buffer.from("x"));
  connector.put("b", "/Specs/Misc/Readme.docx", Buffer.from("x"));
  connector.put("c", "/Other/UC-001.docx", Buffer.from("x"));
  app = await buildServer({
    db,
    // Tokens in these tests are just user keys; a real deployment verifies Entra JWTs.
    verify: async (token) => {
      const u = USERS[token];
      if (!u) throw new Error("bad token");
      return u;
    },
    enqueue: async (job) => jobs.push(job),
    connectorFor: () => connector,
    directory: { searchSites: async () => [], listDrives: async () => [], listFolders: async () => [] },
    blobs: new MemoryBlobStore(),
  });
  app.log.level = "silent";
});

afterEach(async () => {
  await app.close();
  await close();
});

const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: who ? { authorization: `Bearer ${who}` } : {} });

const NEW_SOURCE = { name: "Specs", connector: "onedrive", driveId: "drive-1", folderPath: "/Specs" };

describe("authentication", () => {
  it("rejects missing and invalid tokens with 401", async () => {
    expect((await call("GET", "/admin/sources")).statusCode).toBe(401);
    expect((await call("GET", "/admin/sources", "forged-token")).statusCode).toBe(401);
    expect((await call("GET", "/me")).statusCode).toBe(401);
  });

  it("leaves the health check public", async () => {
    expect((await call("GET", "/health")).statusCode).toBe(200);
  });
});

describe("role checks on every admin route", () => {
  const adminOnly: Array<["GET" | "POST" | "PATCH" | "DELETE", string]> = [
    ["POST", "/admin/sources"],
    ["PATCH", "/admin/sources/00000000-0000-0000-0000-000000000000"],
    ["DELETE", "/admin/sources/00000000-0000-0000-0000-000000000000"],
    ["POST", "/admin/sources/00000000-0000-0000-0000-000000000000/sync"],
    ["POST", "/admin/sources/00000000-0000-0000-0000-000000000000/pause"],
    ["POST", "/admin/sources/preview"],
    ["POST", "/admin/crawl-runs/00000000-0000-0000-0000-000000000000/retry-failed"],
    ["GET", "/admin/graph/sites"],
    ["GET", "/admin/secrets/status"],
    ["GET", "/admin/audit-log"],
  ];
  const reviewerAllowed: Array<["GET" | "POST", string]> = [
    ["GET", "/admin/sources"],
    ["GET", "/admin/crawl-runs"],
    ["GET", "/admin/documents"],
  ];

  it.each(adminOnly)("%s %s: 403 for reviewers and users", async (method, url) => {
    for (const who of ["reviewer", "user"]) {
      expect((await call(method, url, who, {})).statusCode, `${who} ${method} ${url}`).toBe(403);
    }
  });

  it.each(reviewerAllowed)("%s %s: reviewers allowed, plain users 403", async (method, url) => {
    expect((await call(method, url, "reviewer")).statusCode).toBe(200);
    expect((await call(method, url, "user")).statusCode).toBe(403);
  });
});

describe("sources", () => {
  it("creates a source, audits it, schedules it and queues a first full crawl", async () => {
    const res = await call("POST", "/admin/sources", "admin", NEW_SOURCE);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).not.toHaveProperty("deltaLink");
    expect(jobs.map((j) => j.name)).toEqual(["sync-schedulers", "crawl"]);
    expect(jobs[1]!.data).toEqual({ sourceId: body.id, trigger: "full" });

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({ actorId: "u-admin", action: "create", entity: "source", entityId: body.id });
  });

  it("validates input", async () => {
    const res = await call("POST", "/admin/sources", "admin", { name: "" });
    expect(res.statusCode).toBe(400);
  });

  it("forces a full crawl when the folder changes, but not for a schedule change", async () => {
    const { id } = (await call("POST", "/admin/sources", "admin", NEW_SOURCE)).json();
    await db.update(sources).set({ deltaLink: "cursor-1" });
    jobs = [];

    await call("PATCH", `/admin/sources/${id}`, "admin", { deltaCron: "*/15 * * * *" });
    expect(jobs.map((j) => j.name)).toEqual(["sync-schedulers"]);
    expect((await db.select().from(sources))[0]!.deltaLink).toBe("cursor-1");

    jobs = [];
    await call("PATCH", `/admin/sources/${id}`, "admin", { folderPath: "/Specs/v2" });
    expect(jobs.map((j) => j.name)).toEqual(["sync-schedulers", "crawl"]);
    expect((await db.select().from(sources))[0]!.deltaLink).toBeNull();
  });

  it("previews which files a source would index", async () => {
    const res = await call("POST", "/admin/sources/preview", "admin", NEW_SOURCE);
    expect(res.json()).toMatchObject({
      matched: 2,
      missingUcId: 1,
      files: expect.arrayContaining([expect.objectContaining({ path: "/Specs/UCS/UC-045 Monitor.docx", ucId: "UC-045", docType: "UCS" })]),
    });
  });
});

describe("documents", () => {
  it("lists documents with their chunk and screen counts", async () => {
    const { id: sourceId } = (await call("POST", "/admin/sources", "admin", NEW_SOURCE)).json();
    const [doc] = await db
      .insert(documents)
      .values({ sourceId, externalId: "x", path: "/Specs/UCS/UC-045.docx", name: "UC-045.docx", webUrl: "u", ucId: "UC-045", docType: "UCS", status: "indexed" })
      .returning();
    await db.insert(chunks).values(
      [0, 1, 2].map((i) => ({ documentId: doc!.id, docType: "UCS", section: "Main Flow", headingPath: [], ordinal: i, text: `t${i}`, textHash: `h${i}` })),
    );

    const res = await call("GET", "/admin/documents", "reviewer");
    expect(res.json()).toMatchObject({ total: 1, items: [{ ucId: "UC-045", chunkCount: 3, screenCount: 0 }] });
  });
});

describe("secrets", () => {
  it("reports only whether each secret is set, never its value", async () => {
    process.env.VOYAGE_API_KEY = "super-secret-value";
    const res = await call("GET", "/admin/secrets/status", "admin");
    expect(res.body).not.toContain("super-secret-value");
    expect(res.json()).toContainEqual({ name: "VOYAGE_API_KEY", set: true });
    delete process.env.VOYAGE_API_KEY;
  });
});

describe("me", () => {
  it("returns the signed-in user and roles", async () => {
    const res = await call("GET", "/me", "reviewer");
    expect(res.json()).toEqual({ id: "u-rev", name: "Reviewer", roles: ["Assistant.ContentReviewer"] satisfies Role[] });
  });
});
