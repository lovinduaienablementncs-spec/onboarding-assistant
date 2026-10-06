import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { handleQuestion, Retriever, type PipelineDeps } from "@oa/agents";
import { screens, sources, spans, videoJobs, type Db } from "@oa/db";
import { AssistantSettings, SourceConfig } from "@oa/shared";
import { SilentTts } from "@oa/video";
import { FakeModels, KeywordReranker } from "../../../test/fake-models.js";
import { createTestDb, FakeConnector, FakeEmbedder, makeUcsDocx, makeUisDocx, MemoryBlobStore } from "../../../test/helpers.js";
import { runCrawl } from "./crawl.js";
import { describeScreens, runVideoJob, type MediaDeps } from "./media.js";

const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;

let db: Db;
let close: () => Promise<void>;
let models: FakeModels;
let blobs: MemoryBlobStore;
let media: MediaDeps;
let pipeline: PipelineDeps;
const settings = AssistantSettings.parse({ grounding: { minRelevance: 0.5 } });

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  const embedder = new FakeEmbedder();
  blobs = new MemoryBlobStore();
  models = new FakeModels();
  const connector = new FakeConnector();
  const screenshot = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#e2e8f0" } }).png().toBuffer();
  const [s] = await db.insert(sources).values(SourceConfig.parse({ name: "S", connector: "onedrive", driveId: "d", folderPath: "/Specs" })).returning();
  connector.put(
    "ucs",
    "/Specs/UCS/UC-045 Monitor Submissions.docx",
    await makeUcsDocx({ title: "UC-045 Monitor Submissions", mainFlow: ["Open Submission Monitor.", "Click Reprocess Failed to resubmit failed records."], rules: [] }),
  );
  connector.put("uis", "/Specs/UIS/UC-045 UI.docx", await makeUisDocx({ title: "UC-045 UI", screens: [{ name: "Submission Monitor", text: "Grid with the Reprocess Failed button.", image: screenshot }] }));
  await runCrawl({ db, embedder, blobs, connectorFor: () => connector, backoffMs: () => 0 }, s!.id, "full");

  media = { db, models, blobs, embedder, tts: new SilentTts(), settings: async () => settings };
  pipeline = { db, models, retriever: new Retriever(db, embedder, new KeywordReranker()), enqueueVideo: async () => {}, settings: async () => settings };
});

afterEach(async () => close());

async function askHowTo() {
  models.routeResult = { intent: "ui_howto" };
  let jobId = "";
  await handleQuestion(pipeline, { question: "How do I reprocess failed records in Submission Monitor?", user: { id: "u", defaultAudience: "end_user" } }, (e) => {
    if (e.type === "video") jobId = e.jobId;
  });
  return jobId;
}

describe("describeScreens", () => {
  it("describes new screenshots once and stores an embedding", async () => {
    expect(await describeScreens(media)).toEqual({ described: 1, failed: 0 });
    const [row] = await db.select().from(screens);
    expect(row!.description?.uiElements[0]?.label).toBe("Reprocess Failed");
    expect(row!.embedding).toHaveLength(1024);
    expect(await describeScreens(media)).toEqual({ described: 0, failed: 0 });
  });

  it("records failures instead of retrying forever", async () => {
    const [row] = await db.select().from(screens);
    await blobs.put(row!.blobKey, Buffer.from("not an image"), "image/png");
    expect(await describeScreens(media)).toEqual({ described: 0, failed: 1 });
    expect((await db.select().from(screens))[0]!.describeError).toBeTruthy();
    expect(await describeScreens(media)).toEqual({ described: 0, failed: 0 });
  });
});

describe("runVideoJob", () => {
  it("renders a playable MP4 from verified steps and real screenshots", async () => {
    await describeScreens(media);
    const jobId = await askHowTo();
    await runVideoJob(media, jobId);

    const [job] = await db.select().from(videoJobs).where(eq(videoJobs.id, jobId));
    expect(job).toMatchObject({ status: "ready", hasVoice: false });
    expect(job!.durationSec).toBeGreaterThan(5);
    const scenes = (job!.storyboard as { scenes: Array<{ screenId: string | null; box: unknown }> }).scenes;
    expect(scenes.some((s) => s.screenId && s.box)).toBe(true);

    // ffmpeg can decode it and it has video and audio streams.
    const dir = mkdtempSync(join(tmpdir(), "oa-test-"));
    try {
      const file = join(dir, "v.mp4");
      writeFileSync(file, await blobs.get(job!.blobKey!));
      let probe = "";
      try {
        execFileSync(ffmpeg, ["-hide_banner", "-i", file], { stdio: "pipe" });
      } catch (err) {
        probe = String((err as { stderr?: Buffer }).stderr);
      }
      expect(probe).toMatch(/Video: h264/);
      expect(probe).toMatch(/Audio: aac/);
      expect(probe).toMatch(/1920x1080/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops invented screens and labels, and replaces unsupported narration with the verified step", async () => {
    await describeScreens(media);
    const jobId = await askHowTo();
    const [job] = await db.select().from(videoJobs).where(eq(videoJobs.id, jobId));
    const steps = (job!.input as { steps: Array<{ id: number; text: string }> }).steps;
    models.storyboardScenes = [
      { screenId: "00000000-0000-0000-0000-000000000000", element: "Delete All", caption: "x", narration: steps[0]!.text, claimIds: [steps[0]!.id] },
      { screenId: null, element: null, caption: "x", narration: "Reprocessing also notifies your manager by SMS.", claimIds: [steps[1]!.id] },
      { screenId: null, element: null, caption: "x", narration: "A scene with no verified step.", claimIds: [999] },
    ];
    models.rejectClaimsContaining = "SMS";
    await runVideoJob(media, jobId);

    const [done] = await db.select().from(videoJobs).where(eq(videoJobs.id, jobId));
    const scenes = (done!.storyboard as { scenes: Array<{ screenId: string | null; box: unknown; narration: string; narrationSource: string }> }).scenes;
    expect(scenes).toHaveLength(2);
    expect(scenes[0]).toMatchObject({ screenId: null, box: null });
    expect(scenes[1]!.narration).not.toContain("SMS");
    expect(scenes[1]!.narrationSource).toBe("extractive");

    const [grounding] = await db.select().from(spans).where(eq(spans.name, "video_grounding"));
    expect(grounding!.data).toMatchObject({ kept: 2, replacedNarrations: 1 });
  });
});
