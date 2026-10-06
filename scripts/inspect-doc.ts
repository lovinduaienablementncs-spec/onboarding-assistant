/**
 * Shows how a document is parsed and chunked, to check new document formats.
 * Run: npx tsx scripts/inspect-doc.ts <file.docx|file.pdf> [UCS|UIS]
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import mammoth from "mammoth";
import { chunkDocument, parseDocument } from "../packages/ingestion/src/index.js";

const [file, type = "UCS"] = process.argv.slice(2);
if (!file) throw new Error("Usage: inspect-doc.ts <file> [UCS|UIS]");
const data = await readFile(file);

if (file.toLowerCase().endsWith(".docx")) {
  // Which Word styles are used, and which ones mammoth does not map (those become plain paragraphs).
  const { messages } = await mammoth.convertToHtml({ buffer: data });
  const unmapped = [...new Set(messages.map((m) => m.message))];
  console.log(`Unrecognised Word styles: ${unmapped.length ? "\n  " + unmapped.join("\n  ") : "none"}`);
}

const doc = await parseDocument(basename(file), data);
console.log(`\nTitle: ${doc.title}\nSections: ${doc.sections.length}`);
for (const s of doc.sections) {
  const imgs = s.images.length ? `  [${s.images.length} image(s): ${s.images.map((i) => `${i.contentType} ${Math.round(i.data.length / 1024)}KB`).join(", ")}]` : "";
  console.log(`\n# ${s.headingPath.join(" > ") || "(no heading)"}  (${s.text.length} chars)${imgs}`);
  console.log("  " + s.text.slice(0, 160).replace(/\n/g, " / "));
}

const chunks = chunkDocument(doc, "UC-XXX", type as "UCS" | "UIS");
console.log(`\nChunks: ${chunks.length}`);
for (const c of chunks) console.log(`  ${c.section.padEnd(40)} ${c.text.length} chars`);
