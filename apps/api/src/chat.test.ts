import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Retriever } from "@oa/agents";
import { feedback, sources, type Db } from "@oa/db";
import { AssistantSettings, SourceConfig } from "@oa/shared";
import { runCrawl } from "../../worker/src/crawl.js";
import { FakeModels, KeywordReranker } from "../../../test/fake-models.js";
import { createTestDb, FakeConnector, FakeEmbedder, makeUcsDocx, MemoryBlobStore } from "../../../test/helpers.js";
import type { AuthUser } from "./auth.js";
import { buildServer } from "./server.js";

const USERS: Record<string, AuthUser> = {
  alice: { id: "alice", name: "Alice", roles: ["Assistant.User"] },
  bob: { id: "bob", name: "Bob", roles: ["Assistant.User"] },
  admin: { id: "admin", name: "Admin", roles: ["Assistant.Admin"] },
  noroles: { id: "x", roles: [] },
};

let db: Db;
let close: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const embedder = new FakeEmbedder();
  const connector = new FakeConnector();
  const [s] = await db.insert(sources).values(SourceConfig.parse({ name: "S", connector: "onedrive", driveId: "d", folderPath: "/Specs" })).returning();
  connector.put(
    "ucs",
    "/Specs/UCS/UC-045 Monitor Submissions.docx",
    await makeUcsDocx({ title: "UC-045 Monitor Submissions", mainFlow: ["Open Submission Monitor.", "Click Reprocess Failed to resubmit failed records."], rules: [] }),
  );
  await runCrawl({ db, embedder, blobs: new MemoryBlobStore(), connectorFor: () => connector, backoffMs: () => 0 }, s!.id, "full");
  const settings = AssistantSettings.parse({ grounding: { minRelevance: 0.5 } });

  app = await buildServer({
    db,
    verify: async (token) => {
      const u = USERS[token];
      if (!u) throw new Error("bad token");
      return u;
    },
    enqueue: async () => {},
    connectorFor: () => connector,
    directory: { searchSites: async () => [], listDrives: async () => [], listFolders: async () => [] },
    blobs: new MemoryBlobStore(),
    pipeline: { db, models: new FakeModels(), retriever: new Retriever(db, embedder, new KeywordReranker()), enqueueVideo: async () => {}, settings: async () => settings },
    publicConfig: { authMode: "dev" },
  });
  app.log.level = "silent";
});

afterEach(async () => {
  await app.close();
  await close();
});

const auth = (who: string) => ({ authorization: `Bearer ${who}` });

function parseSse(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((raw) => ({ type: /^event: (.*)$/m.exec(raw)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? "null") }));
}

async function chat(who: string, message: string, conversationId?: string) {
  const res = await app.inject({ method: "POST", url: "/chat", headers: auth(who), payload: { message, conversationId } });
  return { res, events: parseSse(res.body) };
}

describe("chat API", () => {
  it("streams status events, then the grounded answer, then done", async () => {
    const { res, events } = await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(events.map((e) => e.type)).toEqual(["status", "status", "status", "status", "answer", "done"]);
    expect(events[4]!.data).toMatchObject({ outcome: "answered", sources: expect.arrayContaining([expect.objectContaining({ ucId: "UC-045" })]) });
  });

  it("keeps conversations private to their owner", async () => {
    const { events } = await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    const conversationId = events.find((e) => e.type === "answer")!.data.conversationId;

    expect((await app.inject({ url: `/conversations/${conversationId}`, headers: auth("alice") })).statusCode).toBe(200);
    expect((await app.inject({ url: `/conversations/${conversationId}`, headers: auth("bob") })).statusCode).toBe(404);
    expect((await app.inject({ url: "/conversations", headers: auth("bob") })).json()).toEqual([]);
    const intrude = await chat("bob", "Continue please", conversationId);
    expect(intrude.res.statusCode).toBe(404);
  });

  it("stores feedback only from the message owner", async () => {
    const { events } = await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    const messageId = events.find((e) => e.type === "answer")!.data.messageId;
    expect((await app.inject({ method: "POST", url: `/messages/${messageId}/feedback`, headers: auth("bob"), payload: { rating: -1 } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/messages/${messageId}/feedback`, headers: auth("alice"), payload: { rating: -1, comment: "too short" } })).statusCode).toBe(200);
    expect(await db.select().from(feedback)).toEqual([expect.objectContaining({ userId: "alice", rating: -1, comment: "too short" })]);
  });

  it("requires a role to chat, and admin roles to read traces", async () => {
    expect((await chat("noroles", "hello")).res.statusCode).toBe(403);
    const { events } = await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    const sessions = await app.inject({ url: "/admin/sessions", headers: auth("admin") });
    const traceId = sessions.json()[0].id;
    expect((await app.inject({ url: `/admin/traces/${traceId}`, headers: auth("alice") })).statusCode).toBe(403);
    const trace = await app.inject({ url: `/admin/traces/${traceId}`, headers: auth("admin") });
    expect(trace.json().spans.map((s: { name: string }) => s.name)).toContain("grounding");
    expect(events.length).toBeGreaterThan(0);
  });

  it("exposes non-secret sign-in config without authentication", async () => {
    expect((await app.inject({ url: "/config" })).json()).toEqual({ authMode: "dev" });
  });
});

describe("admin AI routes", () => {
  it("saves settings as new versions and rolls back", async () => {
    const put = await app.inject({ method: "PUT", url: "/admin/settings", headers: auth("admin"), payload: { grounding: { minRelevance: 0.6 } } });
    expect(put.json()).toMatchObject({ version: 1, value: { grounding: { minRelevance: 0.6 } } });
    await app.inject({ method: "PUT", url: "/admin/settings", headers: auth("admin"), payload: { grounding: { minRelevance: 0.7 } } });
    await app.inject({ method: "POST", url: "/admin/settings/1/activate", headers: auth("admin") });
    expect((await app.inject({ url: "/admin/settings", headers: auth("admin") })).json().grounding.minRelevance).toBe(0.6);
    expect((await app.inject({ method: "PUT", url: "/admin/settings", headers: auth("alice"), payload: {} })).statusCode).toBe(403);
  });

  it("lists documentation gaps, negative feedback and top use cases", async () => {
    const { events } = await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    await chat("alice", "How do I configure payroll overtime multipliers?");
    const messageId = events.find((e) => e.type === "answer")!.data.messageId;
    await app.inject({ method: "POST", url: `/messages/${messageId}/feedback`, headers: auth("alice"), payload: { rating: -1, comment: "missing detail" } });
    const res = await app.inject({ url: "/admin/insights", headers: auth("admin") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      refused: [expect.objectContaining({ question: "How do I configure payroll overtime multipliers?", reason: "low_relevance" })],
      negativeFeedback: [expect.objectContaining({ comment: "missing detail" })],
      topUseCases: [{ ucId: "UC-045", count: expect.any(Number) }],
    });
  });

  it("reports usage with cost per step", async () => {
    await chat("alice", "How do I reprocess failed records in Submission Monitor?");
    const usage = (await app.inject({ url: "/admin/usage?days=1", headers: auth("admin") })).json();
    expect(usage.sessions.sessions).toBe(1);
    expect(usage.byStep.map((s: { step: string }) => s.step)).toEqual(expect.arrayContaining(["answer", "router", "verifier"]));
    expect(usage.byUser[0]).toMatchObject({ userId: "alice", userName: "Alice" });
  });
});
