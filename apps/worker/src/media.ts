import Anthropic from "@anthropic-ai/sdk";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import sharp from "sharp";
import { documents, screens, videoJobs, type Db } from "@oa/db";
import { Tracer, type Models, type StoryboardScene, type VideoJobInput } from "@oa/agents";
import type { BlobStore, Embedder } from "@oa/ingestion";
import { env, type AssistantSettings, type ScreenDescription } from "@oa/shared";
import { renderVideo, type RenderScene, type Tts } from "@oa/video";

export interface MediaDeps {
  db: Db;
  models: Models;
  blobs: BlobStore;
  embedder: Embedder;
  tts: Tts;
  settings: () => Promise<AssistantSettings>;
}

/** Long edge sent to the vision model; larger images are scaled down first. */
const VISION_MAX_EDGE = 1568;

/**
 * Describes screenshots that have no description yet: visible elements with
 * bounding boxes, used later to highlight the right element in videos.
 */
export async function describeScreens(deps: MediaDeps, limit = 20): Promise<{ described: number; failed: number }> {
  const { db } = deps;
  const pending = await db
    .select({ id: screens.id, blobKey: screens.blobKey, context: screens.context, caption: screens.caption })
    .from(screens)
    .innerJoin(documents, eq(documents.id, screens.documentId))
    .where(and(isNull(screens.description), isNull(screens.describeError), isNull(documents.deletedAt)))
    .orderBy(asc(screens.createdAt))
    .limit(limit);
  if (!pending.length) return { described: 0, failed: 0 };

  const tracer = new Tracer(db, { kind: "vision", question: `Describe ${pending.length} screenshot(s)` });
  let described = 0;
  let failed = 0;
  for (const s of pending) {
    try {
      const image = await sharp(await deps.blobs.get(s.blobKey))
        .resize(VISION_MAX_EDGE, VISION_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
        .png()
        .toBuffer();
      const description = await tracer.span("describe_screen", async (data) => {
        const d = await deps.models.describeScreen({ image, mediaType: "image/png", context: [s.caption, s.context].filter(Boolean).join("\n") }, tracer);
        Object.assign(data, { screenId: s.id, screenName: d.screenName, elements: d.uiElements.length });
        return d;
      });
      const t0 = Date.now();
      const { vectors, tokens } = await deps.embedder.embed([describeText(description)], "document");
      await tracer.recordCall({ step: "embed_screen", provider: "voyage", model: env.embeddingModel, usage: { inputTokens: tokens }, latencyMs: Date.now() - t0 });
      await db.update(screens).set({ description, embedding: vectors[0], describeError: null }).where(eq(screens.id, s.id));
      described++;
    } catch (err) {
      // A bad key or account problem is not the screenshot's fault: stop and retry later.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        await tracer.finish("error");
        throw err;
      }
      // Recorded so it is not retried forever; an admin can clear it from the Screens page.
      await db.update(screens).set({ describeError: String(err).slice(0, 500) }).where(eq(screens.id, s.id));
      failed++;
    }
  }
  await tracer.finish(failed ? "partial" : "ok");
  return { described, failed };
}

export function describeText(d: ScreenDescription): string {
  return `${d.screenName}. ${d.purpose}. ${d.navigationPath}. Elements: ${d.uiElements.map((e) => `${e.label} (${e.type})`).join(", ")}`;
}

const stripMarks = (s: string) =>
  s
    .replace(/\[\d+\]/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/^\s*(\d+[.)]|[-•])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Builds and renders one video: Claude plans scenes from the verified steps,
 * every scene is checked (real screenshot, real element label, narration
 * supported by the cited quotes), then frames, speech and FFmpeg make the MP4.
 */
export async function runVideoJob(deps: MediaDeps, jobId: string): Promise<void> {
  const { db } = deps;
  const [job] = await db.select().from(videoJobs).where(eq(videoJobs.id, jobId));
  if (!job || job.status === "ready") return;
  const settings = await deps.settings();
  const input = job.input as unknown as VideoJobInput;
  const tracer = new Tracer(db, { kind: "video", question: input.question });

  try {
    await db.update(videoJobs).set({ status: "storyboard" }).where(eq(videoJobs.id, jobId));
    const screenRows = input.screenIds.length
      ? await db.select().from(screens).where(and(inArray(screens.id, input.screenIds), sql`${screens.description} is not null`))
      : [];
    const screenById = new Map(screenRows.map((s) => [s.id, s]));
    const stepById = new Map(input.steps.map((s) => [s.id, s]));

    const planned: StoryboardScene[] = await tracer.span("storyboard", async (data) => {
      const scenes = await deps.models.storyboard(
        {
          question: input.question,
          steps: input.steps.map((s) => ({ id: s.id, text: stripMarks(s.text) })),
          screens: screenRows.map((s) => ({ id: s.id, caption: s.caption, description: s.description })),
          maxScenes: settings.video.maxScenes,
        },
        tracer,
      );
      Object.assign(data, { planned: scenes.length, screensAvailable: screenRows.length });
      return scenes;
    });

    // Validate every scene against what actually exists.
    const scenes = await tracer.span("video_grounding", async (data) => {
      const checks: Array<Record<string, unknown>> = [];
      const valid = planned
        .map((s) => {
          const claimIds = s.claimIds.filter((id) => stepById.has(id));
          const screen = s.screenId ? screenById.get(s.screenId) : undefined;
          const element = screen?.description?.uiElements.find((e) => e.label.toLowerCase() === s.element?.toLowerCase());
          checks.push({ screenId: s.screenId, screenExists: Boolean(screen), element: s.element, elementFound: Boolean(element), claimIds });
          return { ...s, claimIds, screen, box: element?.box ?? null };
        })
        .filter((s) => s.claimIds.length);

      // Narration must be supported by the quotes of the steps it is based on.
      const verdicts =
        settings.grounding.narrationMode === "generative" && valid.length
          ? await deps.models.verify(
              valid.map((s, i) => ({ id: i, claim: s.narration, quotes: s.claimIds.flatMap((id) => stepById.get(id)!.quotes) })),
              tracer,
            )
          : [];
      const out = valid.map((s, i) => {
        const extractive = s.claimIds.map((id) => stripMarks(stepById.get(id)!.text)).join(" ");
        const supported = verdicts.find((v) => v.id === i)?.supported ?? false;
        const narration = settings.grounding.narrationMode === "generative" && supported ? s.narration : extractive;
        return { ...s, narration, narrationSource: narration === s.narration ? "generated" : "extractive" };
      });
      Object.assign(data, { checks, kept: out.length, replacedNarrations: out.filter((s) => s.narrationSource === "extractive").length });
      return out;
    });
    if (!scenes.length) throw new Error("No scene could be grounded in the verified steps");

    await db.update(videoJobs).set({ status: "rendering" }).where(eq(videoJobs.id, jobId));
    const renderScenes: RenderScene[] = [
      { title: input.question, caption: "A short guide based on the system documentation.", narration: "Here is a short guide based on the system documentation." },
    ];
    for (const s of scenes) {
      let image: Buffer | undefined;
      if (s.screen) {
        try {
          image = await deps.blobs.get(s.screen.blobKey);
          await sharp(image).metadata(); // unsupported formats (e.g. EMF) fall back to a text card
        } catch {
          image = undefined;
        }
      }
      renderScenes.push({ image, box: image ? s.box : null, title: s.narration, caption: s.narration, narration: s.narration });
    }

    const result = await tracer.span("render", async (data) => {
      const r = await renderVideo(renderScenes, { tts: deps.tts, voice: settings.video.voice });
      Object.assign(data, { scenes: renderScenes.length, seconds: Number(r.seconds.toFixed(1)), voiced: r.voiced, bytes: r.mp4.length });
      return r;
    });
    if (result.voiced) {
      await tracer.recordCall({ step: "tts", provider: "azure", model: "azure-tts-neural", usage: { units: result.ttsCharacters }, latencyMs: 0 });
    }

    const blobKey = `videos/${jobId}.mp4`;
    await deps.blobs.put(blobKey, result.mp4, "video/mp4");
    await db
      .update(videoJobs)
      .set({
        status: "ready",
        blobKey,
        durationSec: result.seconds,
        hasVoice: result.voiced,
        storyboard: { scenes: scenes.map((s) => ({ screenId: s.screen?.id ?? null, element: s.element, box: s.box, narration: s.narration, narrationSource: s.narrationSource, claimIds: s.claimIds })) },
        finishedAt: new Date(),
      })
      .where(eq(videoJobs.id, jobId));
    await tracer.finish("ok");
  } catch (err) {
    await db.update(videoJobs).set({ status: "failed", error: String(err).slice(0, 1000), finishedAt: new Date() }).where(eq(videoJobs.id, jobId));
    await tracer.finish("error");
    throw err;
  }
}
