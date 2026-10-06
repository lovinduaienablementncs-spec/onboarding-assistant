import type { DocType, DocTypeRule, ParsedDocument } from "@oa/shared";

/** Extracts and normalises a UC id (e.g. "uc_45" -> "UC-045") from a path or title. */
export function extractUcId(text: string, pattern: string): string | null {
  const m = new RegExp(pattern, "i").exec(text);
  if (!m) return null;
  const digits = /\d+/.exec(m[0])?.[0];
  return digits ? `UC-${digits.padStart(3, "0")}` : m[0].toUpperCase();
}

export function classifyDocType(path: string, rules: DocTypeRule[]): DocType {
  for (const rule of rules) if (new RegExp(rule.pathPattern, "i").test(path)) return rule.type;
  return "OTHER";
}

const CONTENT_TYPES: Array<[DocType, RegExp]> = [
  ["UIS", /user interface specification|\bUI spec(ification)?\b/i],
  ["UCS", /use case specification|\buse case\b/i],
];

/**
 * What the document says it is, from its title and header block. Folders are
 * not always reliable, so this wins over the path rules when it finds a match.
 * Only the header is read, so a UCS that mentions "the related UI specification"
 * further down is not misread.
 */
export function detectDocTypeFromContent(doc: ParsedDocument): DocType | null {
  for (const text of [doc.title, documentHeader(doc)]) {
    let best: { type: DocType; at: number } | null = null;
    for (const [type, re] of CONTENT_TYPES) {
      const at = text.search(re);
      if (at >= 0 && (!best || at < best.at)) best = { type, at };
    }
    if (best) return best.type;
  }
  return null;
}

/** Title plus the text before the first heading (document id, version, module name). */
export function documentHeader(doc: ParsedDocument): string {
  const first = doc.sections[0];
  const preamble = first && !first.headingPath.length ? first.text : "";
  return `${doc.title}\n${preamble}`.slice(0, 1000);
}
