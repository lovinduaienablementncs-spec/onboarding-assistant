import type { ParsedDocument, ParsedSection } from "@oa/shared";
import { canonicalSection } from "../chunker.js";

/**
 * Extracts text from a PDF and splits it on lines that look like known UCS
 * section headings. Image extraction from PDFs is not supported yet; UIS
 * screenshots are read from .docx files.
 */
export async function parsePdf(name: string, data: Buffer): Promise<ParsedDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let line = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      line += item.str;
      if (item.hasEOL) {
        lines.push(line.trim());
        line = "";
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  await doc.destroy();

  const sections: ParsedSection[] = [];
  let current: ParsedSection = { headingPath: [], text: "", images: [] };
  for (const line of lines) {
    if (line.length < 60 && canonicalSection(line)) {
      if (current.text.trim()) sections.push(current);
      current = { headingPath: [line], text: "", images: [] };
    } else if (line) {
      current.text += line + "\n";
    }
  }
  if (current.text.trim()) sections.push(current);
  return { title: name.replace(/\.[^.]+$/, ""), sections: sections.map((s) => ({ ...s, text: s.text.trim() })) };
}
