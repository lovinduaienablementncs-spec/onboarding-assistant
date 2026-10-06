import type { ParsedDocument } from "@oa/shared";
import { parseDocx } from "./docx.js";
import { parsePdf } from "./pdf.js";

export async function parseDocument(name: string, data: Buffer): Promise<ParsedDocument> {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "docx") return parseDocx(name, data);
  if (ext === "pdf") return parsePdf(name, data);
  throw new Error(`Unsupported file type: ${name}`);
}
