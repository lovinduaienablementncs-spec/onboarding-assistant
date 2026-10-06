import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { renderFrame, type FrameSpec } from "./frame.js";
import type { Tts } from "./tts.js";

const run = promisify(execFile);
// ffmpeg-static is CommonJS and exports the binary path (or null on unsupported platforms).
const ffmpegPath = createRequire(import.meta.url)("ffmpeg-static") as string | null;

export interface RenderScene extends Omit<FrameSpec, "counter"> {
  narration: string;
}

export interface RenderResult {
  mp4: Buffer;
  seconds: number;
  ttsCharacters: number;
  voiced: boolean;
}

/** Pause after each scene's narration, in seconds. */
const GAP = 0.6;

/**
 * Renders scenes to an H.264/AAC MP4: one still frame per scene held for the
 * length of its narration, then concatenated without re-encoding.
 */
export async function renderVideo(scenes: RenderScene[], opts: { tts: Tts; voice: string }): Promise<RenderResult> {
  if (!ffmpegPath) throw new Error("ffmpeg binary not available");
  const dir = await mkdtemp(join(tmpdir(), "oa-video-"));
  try {
    const segments: string[] = [];
    let seconds = 0;
    let ttsCharacters = 0;
    for (const [i, scene] of scenes.entries()) {
      const frame = await renderFrame({ ...scene, counter: i === 0 ? undefined : `Step ${i} of ${scenes.length - 1}` });
      const speech = await opts.tts.synthesize(scene.narration, opts.voice);
      if (opts.tts.voiced) ttsCharacters += scene.narration.length;
      const framePath = join(dir, `f${i}.png`);
      const audioPath = join(dir, `a${i}.wav`);
      const segPath = join(dir, `s${i}.mp4`);
      await writeFile(framePath, frame);
      await writeFile(audioPath, speech.wav);
      const duration = speech.seconds + GAP;
      await run(ffmpegPath, [
        "-y", "-loglevel", "error",
        "-loop", "1", "-framerate", "25", "-i", framePath,
        "-i", audioPath,
        "-af", `apad=pad_dur=${GAP}`,
        "-t", duration.toFixed(2),
        "-c:v", "libx264", "-tune", "stillimage", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-r", "25",
        "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "1",
        segPath,
      ]);
      segments.push(segPath);
      seconds += duration;
    }

    const listPath = join(dir, "list.txt");
    await writeFile(listPath, segments.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
    const outPath = join(dir, "out.mp4");
    await run(ffmpegPath, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outPath]);
    return { mp4: await readFile(outPath), seconds, ttsCharacters, voiced: opts.tts.voiced };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
