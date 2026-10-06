import mammoth from "mammoth";
import { parse, type HTMLElement, NodeType } from "node-html-parser";
import type { ParsedDocument, ParsedImage, ParsedSection } from "@oa/shared";

/**
 * Converts a .docx to sections split on headings, keeping embedded images
 * attached to the section they appear in.
 */
export async function parseDocx(name: string, data: Buffer): Promise<ParsedDocument> {
  const images: ParsedImage[] = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer: data },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const buf = Buffer.from(await image.read());
        // mammoth exposes altText at runtime but its typings omit it.
        const altText = (image as { altText?: string }).altText;
        images.push({ contentType: image.contentType, data: buf, caption: altText || undefined });
        return { src: `oa-image:${images.length - 1}` };
      }),
    },
  );
  return htmlToDocument(html, images, name.replace(/\.[^.]+$/, ""));
}

export function htmlToDocument(html: string, images: ParsedImage[], fallbackTitle: string): ParsedDocument {
  const root = parse(html);
  const sections: ParsedSection[] = [];
  const headings: string[] = [];
  let current: ParsedSection = { headingPath: [], text: "", images: [] };
  let title: string | undefined;

  const flush = () => {
    if (current.text.trim() || current.images.length) sections.push({ ...current, text: current.text.trim() });
  };

  const elements = root.childNodes.filter((n) => n.nodeType === NodeType.ELEMENT_NODE) as HTMLElement[];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]!;
    const heading = headingOf(el, elements[i + 1]);
    if (heading) {
      if (heading.mergedNext) i++;
      flush();
      headings.length = heading.level - 1;
      headings[heading.level - 1] = heading.text;
      current = { headingPath: headings.filter(Boolean), text: "", images: [] };
      continue;
    }
    const text = stripFooters(blockText(el));
    if (text) {
      // The first short line before any heading is the document title.
      if (!title && !sections.length && !headings.length && !current.text && text.length <= 150) title = text;
      current.text += text + "\n";
    }
    for (const img of el.tagName === "IMG" ? [el] : el.querySelectorAll("img")) {
      const image = images[Number(img.getAttribute("src")?.replace("oa-image:", ""))];
      // Fall back to the paragraph right before the image as its caption.
      if (image) current.images.push({ ...image, caption: image.caption ?? lastLine(current.text) });
    }
  }
  flush();

  return { title: title ?? (root.querySelector("h1")?.text.trim() || fallbackTitle), sections };
}

const NUMBERED_HEADING = /^(\d+(?:\.\d+)*)\.?\s+\S/;

/**
 * Word heading styles become <h1>-<h6>. Many specs instead use a bold,
 * numbered paragraph ("3. LAYOUT GRID", "4.2 Filters"), which is treated as a
 * heading whose level is the depth of its number. Word sometimes splits the
 * number into its own paragraph ("1" then ". DOCUMENT SCOPE"); those are merged.
 */
function headingOf(el: HTMLElement, next?: HTMLElement): { level: number; text: string; mergedNext?: boolean } | null {
  const h = /^h([1-6])$/i.exec(el.tagName)?.[1];
  if (h) return { level: Number(h), text: el.text.trim() };
  if (!isBoldParagraph(el)) return null;

  let text = el.text.trim();
  let mergedNext = false;
  if (/^\d+(\.\d+)*$/.test(text) && next && isBoldParagraph(next) && next.text.trim().startsWith(".")) {
    text = `${text}${next.text.trim()}`;
    mergedNext = true;
  }
  const m = NUMBERED_HEADING.exec(text);
  if (!m || text.length > 100 || /[.:]$/.test(text)) return null;
  return { level: Math.min(m[1]!.split(".").length, 6), text, mergedNext };
}

function isBoldParagraph(el: HTMLElement): boolean {
  if (el.tagName !== "P") return false;
  const text = el.text.trim();
  const bold = el.querySelectorAll("strong").map((s) => s.text).join("").trim();
  return text.length > 0 && bold === text;
}

/** Text with line breaks kept: <br> and nested paragraphs become new lines. */
function textOf(el: HTMLElement, sep = "\n"): string {
  const paras = el.querySelectorAll("p");
  if (paras.length > 1) return paras.map((p) => textOf(p)).filter(Boolean).join(sep);
  return parse(el.innerHTML.replace(/<br\s*\/?>/gi, "\n"))
    .text.split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join(sep);
}

function blockText(el: HTMLElement): string {
  if (el.tagName === "TABLE") {
    return el
      .querySelectorAll("tr")
      .map((tr) => tr.querySelectorAll("th,td").map((c) => textOf(c, "; ")).join(" | "))
      .join("\n");
  }
  if (el.tagName === "OL" || el.tagName === "UL") {
    const ordered = el.tagName === "OL";
    return el.querySelectorAll("li").map((li, i) => `${ordered ? `${i + 1}.` : "-"} ${textOf(li, " ")}`).join("\n");
  }
  return textOf(el);
}

/** Drops running page footers such as "UIS-MTP-TAXNOTICES-01 Page 1 of 2". */
function stripFooters(text: string): string {
  return text
    .split("\n")
    .filter((l) => !(l.length <= 100 && /\bPage \d+ of \d+$/i.test(l)))
    .join("\n");
}

function lastLine(text: string): string | undefined {
  return text.trim().split("\n").filter(Boolean).pop();
}
