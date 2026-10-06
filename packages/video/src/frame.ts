import sharp, { type OverlayOptions } from "sharp";
import { escapeXml } from "./tts.js";

export const WIDTH = 1920;
export const HEIGHT = 1080;
const CAPTION_H = 200;
const PAD = 40;

const COLORS = {
  background: "#0f172a",
  panel: "#111827",
  text: "#f8fafc",
  muted: "#94a3b8",
  highlight: "#f59e0b",
  accent: "#38bdf8",
};

export interface FrameSpec {
  /** Screenshot to show; omitted for a text-only card. */
  image?: Buffer;
  /** Element to highlight, as fractions [x, y, w, h] of the screenshot. */
  box?: [number, number, number, number] | null;
  title: string;
  caption: string;
  /** e.g. "Step 2 of 5" */
  counter?: string;
}

/**
 * Draws one 1920x1080 frame: the screenshot scaled to fit above a caption bar,
 * an amber box around the highlighted element, and the step text.
 */
export async function renderFrame(spec: FrameSpec): Promise<Buffer> {
  const layers: OverlayOptions[] = [];
  const areaW = WIDTH - PAD * 2;
  const areaH = HEIGHT - CAPTION_H - PAD * 2;

  if (spec.image) {
    const img = sharp(spec.image).flatten({ background: "#ffffff" });
    const meta = await img.metadata();
    const scale = Math.min(areaW / (meta.width ?? areaW), areaH / (meta.height ?? areaH));
    const w = Math.max(1, Math.round((meta.width ?? areaW) * scale));
    const h = Math.max(1, Math.round((meta.height ?? areaH) * scale));
    const left = Math.round((WIDTH - w) / 2);
    const top = PAD + Math.round((areaH - h) / 2);
    layers.push({ input: await img.resize(w, h).png().toBuffer(), left, top });

    if (spec.box) {
      const [bx, by, bw, bh] = spec.box;
      const m = 8; // margin so the outline does not cover the element
      const x = Math.max(0, left + bx * w - m);
      const y = Math.max(0, top + by * h - m);
      const rw = Math.min(WIDTH - x, bw * w + m * 2);
      const rh = Math.min(HEIGHT - y, bh * h + m * 2);
      layers.push({
        input: Buffer.from(
          `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
            <path fill-rule="evenodd" fill="#000" fill-opacity="0.45"
              d="M0 0 H${WIDTH} V${HEIGHT - CAPTION_H} H0 Z M${x} ${y} h${rw} v${rh} h${-rw} Z"/>
            <rect x="${x}" y="${y}" width="${rw}" height="${rh}" rx="10" fill="none" stroke="${COLORS.highlight}" stroke-width="6"/>
          </svg>`,
        ),
        left: 0,
        top: 0,
      });
    }
  } else {
    layers.push({ input: Buffer.from(textCard(spec.title)), left: 0, top: 0 });
  }

  layers.push({ input: Buffer.from(captionBar(spec)), left: 0, top: HEIGHT - CAPTION_H });

  return sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: COLORS.background } })
    .composite(layers)
    .png()
    .toBuffer();
}

function textCard(title: string): string {
  const lines = wrap(title, 40).slice(0, 4);
  const startY = (HEIGHT - CAPTION_H) / 2 - (lines.length - 1) * 40;
  return `<svg width="${WIDTH}" height="${HEIGHT - CAPTION_H}" xmlns="http://www.w3.org/2000/svg">
    ${lines
      .map(
        (l, i) =>
          `<text x="${WIDTH / 2}" y="${startY + i * 80}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="60" font-weight="600" fill="${COLORS.text}">${escapeXml(l)}</text>`,
      )
      .join("")}
  </svg>`;
}

function captionBar(spec: FrameSpec): string {
  const lines = wrap(spec.caption, 95).slice(0, 3);
  return `<svg width="${WIDTH}" height="${CAPTION_H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${CAPTION_H}" fill="${COLORS.panel}"/>
    <rect width="${WIDTH}" height="4" fill="${COLORS.accent}"/>
    ${spec.counter ? `<text x="${PAD}" y="48" font-family="Segoe UI, Arial, sans-serif" font-size="26" fill="${COLORS.accent}">${escapeXml(spec.counter)}</text>` : ""}
    ${lines
      .map(
        (l, i) =>
          `<text x="${PAD}" y="${96 + i * 42}" font-family="Segoe UI, Arial, sans-serif" font-size="34" fill="${COLORS.text}">${escapeXml(l)}</text>`,
      )
      .join("")}
  </svg>`;
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
    if (line && (line + " " + word).length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
