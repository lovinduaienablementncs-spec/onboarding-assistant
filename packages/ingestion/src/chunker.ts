import { createHash } from "node:crypto";
import type { ChunkDraft, DocType, ParsedDocument } from "@oa/shared";

const CANONICAL_SECTIONS: Array<[string, RegExp]> = [
  ["Preconditions", /pre[- ]?conditions?/i],
  ["Postconditions", /post[- ]?conditions?/i],
  ["Main Flow", /main (flow|success scenario|scenario)|basic flow|normal flow/i],
  ["Alternate Flows", /alternat\w* flows?|exception\w* flows?|exceptions/i],
  ["Business Rules", /business rules?/i],
  ["Actors", /\bactors?\b/i],
  ["Data Fields", /data (fields?|elements?)|field (list|descriptions?)/i],
  ["Overview", /overview|description|purpose|summary|introduction/i],
];

/** Maps a heading to a standard UCS section name, or null if it isn't one. */
export function canonicalSection(heading: string): string | null {
  for (const [name, re] of CANONICAL_SECTIONS) if (re.test(heading)) return name;
  return null;
}

export const MAX_CHUNK_CHARS = 3000;

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Context line prepended to each chunk so retrieval sees which use case and section it came from. */
export function chunkHeader(c: Pick<ChunkDraft, "ucId" | "docType" | "headingPath">): string {
  return [c.ucId, c.docType, c.headingPath.join(" > ")].filter(Boolean).join(" | ");
}

export function chunkDocument(doc: ParsedDocument, ucId: string | null, docType: DocType): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  for (const s of doc.sections) {
    if (!s.text) continue;
    // Text before the first heading is the document's header block (title, id, version).
    const headingPath = s.headingPath.length ? s.headingPath : [doc.title];
    const section = s.headingPath.length
      ? ([...headingPath].reverse().map(canonicalSection).find((x) => x !== null) ?? headingPath.at(-1)!)
      : "Document Info";
    for (const text of splitText(s.text, MAX_CHUNK_CHARS)) {
      const draft: ChunkDraft = { ucId, docType, section, headingPath, text, ordinal: drafts.length, textHash: "" };
      draft.textHash = sha256(`${chunkHeader(draft)}\n${text}`);
      drafts.push(draft);
    }
  }
  return drafts;
}

/** Splits on paragraph boundaries, repeating the last paragraph of each piece as overlap. */
export function splitText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const paras = text.split(/\n+/).flatMap((p) => {
    if (p.length <= max) return [p];
    const parts: string[] = [];
    for (let i = 0; i < p.length; i += max) parts.push(p.slice(i, i + max));
    return parts;
  });
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paras) {
    if (len + p.length > max && cur.length) {
      out.push(cur.join("\n"));
      const overlap = cur.at(-1)!;
      cur = overlap.length + p.length < max ? [overlap] : [];
      len = cur.reduce((n, s) => n + s.length + 1, 0);
    }
    cur.push(p);
    len += p.length + 1;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}
