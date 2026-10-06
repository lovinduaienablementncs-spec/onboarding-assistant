import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { llmCalls, messages, sources, spans, traces, videoJobs, type Db } from "@oa/db";
import { AssistantSettings, SourceConfig } from "@oa/shared";
import { runCrawl } from "../../../apps/worker/src/crawl.js";
import { FakeModels, KeywordReranker } from "../../../test/fake-models.js";
import { createTestDb, FakeConnector, FakeEmbedder, makeUcsDocx, makeUisDocx, MemoryBlobStore, PNG_RED } from "../../../test/helpers.js";
import { handleQuestion, type ChatEvent, type PipelineDeps } from "./pipeline.js";
import { Retriever } from "./retrieval.js";

let db: Db;
let close: () => Promise<void>;
let models: FakeModels;
let deps: PipelineDeps;
let enqueued: string[];
let settings: AssistantSettings;

const USER = { id: "u1", name: "Nimal", defaultAudience: "end_user" as const };

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const embedder = new FakeEmbedder();
  const connector = new FakeConnector();
  const [s] = await db.insert(sources).values(SourceConfig.parse({ name: "S", connector: "onedrive", driveId: "d", folderPath: "/Specs" })).returning();
  connector.put(
    "ucs",
    "/Specs/UCS/UC-045 Monitor Submissions.docx",
    await makeUcsDocx({
      title: "UC-045 Monitor Submissions",
      mainFlow: ["Open Submission Monitor from the Submissions menu.", "Select a batch to see Pass and Fail record counts.", "Click Reprocess Failed to resubmit failed records."],
      rules: ["BR1: Only failed records can be reprocessed."],
    }),
  );
  connector.put("uis", "/Specs/UIS/UC-045 Monitor Submissions UI.docx", await makeUisDocx({ title: "UC-045 UI", screens: [{ name: "Submission Monitor", text: "Batch grid with Pass and Fail counts and the Reprocess Failed button.", image: PNG_RED }] }));
  await runCrawl({ db, embedder, blobs: new MemoryBlobStore(), connectorFor: () => connector, backoffMs: () => 0 }, s!.id, "full");

  models = new FakeModels();
  enqueued = [];
  settings = AssistantSettings.parse({ grounding: { minRelevance: 0.5 } });
  deps = { db, models, retriever: new Retriever(db, embedder, new KeywordReranker()), enqueueVideo: async (id) => enqueued.push(id), settings: async () => settings };
});

afterEach(async () => close());

async function ask(question: string, conversationId?: string) {
  const events: ChatEvent[] = [];
  await handleQuestion(deps, { question, conversationId, user: USER }, (e) => events.push(e));
  const answer = events.find((e): e is Extract<ChatEvent, { type: "answer" }> => e.type === "answer")!;
  const [msg] = await db.select().from(messages).where(eq(messages.id, answer.messageId));
  const spanNames = (await db.select({ name: spans.name }).from(spans).where(eq(spans.traceId, msg!.traceId!))).map((s) => s.name);
  return { events, answer, msg: msg!, spanNames };
}

describe("scope gates", () => {
  it("refuses an out-of-scope question without searching or calling the answer model", async () => {
    models.routeResult = { intent: "out_of_scope" };
    const { answer, spanNames } = await ask("What is the capital of France?");

    expect(answer.outcome).toBe("refused");
    expect(answer.markdown).toBe(settings.grounding.refusalMessage);
    expect(models.calls.answer).toBe(0);
    expect(spanNames).toEqual(["budget", "router", "scope_gate"]);
  });

  it("refuses when nothing relevant is found, before calling the answer model", async () => {
    const { answer, msg } = await ask("How do I configure payroll overtime multipliers?");
    expect(answer.outcome).toBe("refused");
    expect(models.calls.answer).toBe(0);
    expect(msg.payload).toMatchObject({ refusal: "low_relevance" });
  });
});

describe("grounded answers", () => {
  it("answers from the documents with numbered sources and a full trace", async () => {
    const { answer, spanNames, msg } = await ask("How do I reprocess failed records in Submission Monitor?");

    expect(answer.outcome).toBe("answered");
    expect(answer.markdown).toMatch(/\[1\]/);
    expect(answer.sources[0]).toMatchObject({ n: 1, ucId: "UC-045" });
    expect(spanNames).toEqual(["budget", "router", "retrieval", "scope_gate", "answer", "grounding"]);

    const calls = await db.select().from(llmCalls).where(eq(llmCalls.traceId, msg.traceId!));
    expect(calls.map((c) => c.step).sort()).toEqual(["answer", "embed_query", "rerank", "router", "verifier"]);
    const answerCall = calls.find((c) => c.step === "answer")!;
    // 1000 input x $4/M + 500 output x $20/M
    expect(answerCall.costUsd).toBeCloseTo(0.014, 6);
    const [trace] = await db.select().from(traces).where(eq(traces.id, msg.traceId!));
    expect(trace!.costUsd).toBeCloseTo(calls.reduce((n, c) => n + c.costUsd, 0), 6);
    expect(trace!.outcome).toBe("answered");
  });

  it("never shows a sentence the model invented", async () => {
    models.inventedSentence = "Reprocessing also emails the tax officer automatically.";
    settings = AssistantSettings.parse({ grounding: { minRelevance: 0.5, maxRemovedRatio: 0.5 } });
    const { answer } = await ask("How do I reprocess failed records in Submission Monitor?");
    expect(answer.outcome).toBe("partial");
    expect(answer.markdown).not.toContain("emails the tax officer");
  });

  it("keeps conversation history per user conversation", async () => {
    const first = await ask("How do I reprocess failed records in Submission Monitor?");
    await ask("Which records can be reprocessed in Submission Monitor?", first.answer.conversationId);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, first.answer.conversationId));
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});

describe("video jobs", () => {
  it("queues a video for UI how-to questions and reuses it for the same question", async () => {
    models.routeResult = { intent: "ui_howto" };
    const first = await ask("How do I reprocess failed records in Submission Monitor?");
    const video = first.events.find((e) => e.type === "video");
    expect(video).toMatchObject({ type: "video", status: "queued" });
    expect(enqueued).toHaveLength(1);

    const [job] = await db.select().from(videoJobs);
    expect(job!.ucIds).toEqual(["UC-045"]);
    expect((job!.input as { screenIds: string[] }).screenIds).toHaveLength(1);

    const second = await ask("How do I reprocess failed records in Submission Monitor?");
    expect(second.events.find((e) => e.type === "video")).toMatchObject({ jobId: (video as { jobId: string }).jobId });
    expect(enqueued).toHaveLength(1);
  });

  it("does not make videos for explanations", async () => {
    await ask("Which records can be reprocessed in Submission Monitor?");
    expect(await db.select().from(videoJobs)).toHaveLength(0);
  });
});

describe("budget", () => {
  it("stops before any model call when the daily budget is used up", async () => {
    settings = AssistantSettings.parse({ grounding: { minRelevance: 0.5 }, budget: { dailyUsd: 0.01 } });
    await ask("How do I reprocess failed records in Submission Monitor?");
    const callsBefore = { ...models.calls };
    const { answer, msg } = await ask("How do I reprocess failed records in Submission Monitor?");

    expect(answer.outcome).toBe("refused");
    expect(msg.payload).toMatchObject({ refusal: "budget" });
    expect(models.calls).toEqual(callsBefore);
  });
});
