import type { RetrievedChunk } from "./retrieval.js";

/** A text block of the model's answer with the citations the API attached to it. */
export interface DraftBlock {
  text: string;
  citations: Array<{ documentIndex: number; citedText: string }>;
}

export interface Claim {
  id: number;
  text: string;
  citations: Array<{ chunkId: string; citedText: string }>;
}

export interface Verdict {
  id: number;
  supported: boolean;
  reason: string;
}

export type Verify = (claims: Array<{ id: number; claim: string; quotes: string[] }>) => Promise<Verdict[]>;

export interface Source {
  n: number;
  chunkId: string;
  documentId: string;
  ucId: string | null;
  docType: string;
  section: string;
  docName: string;
  webUrl: string;
}

export interface GroundedAnswer {
  outcome: "answered" | "partial" | "refused";
  markdown: string;
  sources: Source[];
  /** Claims that survived every check, with their citations (used for video storyboards). */
  claims: Claim[];
  removed: Array<{ text: string; reason: "uncited" | "quote_mismatch" | "not_supported"; detail?: string }>;
  gapStatements: string[];
}

/** The prefix the answer prompt requires for statements about missing information. */
export const GAP_PREFIX = "Not covered in the documentation:";

const normalise = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Text without citations is kept only when it carries no facts: whitespace,
 * list markers, headings, short lead-ins ending in a colon, or a statement
 * about what the documents do not cover.
 */
export function isConnective(text: string): boolean {
  // A block often mixes a lead-in with the next list marker ("Steps:\n\n1. "); every line must qualify.
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length > 1) return lines.every((l) => isConnective(l));
  const t = text.trim();
  if (!t) return true;
  if (/^[-*•>#\d.)\s|:]*$/.test(t)) return true;
  if (/^#{1,6}\s+\S.{0,60}$/.test(t) && !/[.!?]$/.test(t)) return true;
  if (t.length <= 70 && t.endsWith(":") && !/\d/.test(t.replace(/^\d+[.)]\s*/, ""))) return true;
  if (/^\*\*[^*]{1,60}\*\*:?$/.test(t)) return true;
  return false;
}

/**
 * Turns the model's cited draft into an answer the user may see:
 * 1. drops sentences with no citation,
 * 2. drops claims whose quoted text is not literally in the cited chunk,
 * 3. drops claims an independent verifier finds unsupported by their quotes,
 * 4. refuses when too much was dropped or nothing grounded is left.
 */
export async function groundAnswer(
  blocks: DraftBlock[],
  chunks: RetrievedChunk[],
  verify: Verify,
  opts: { maxRemovedRatio: number; refusalMessage: string },
): Promise<GroundedAnswer> {
  const removed: GroundedAnswer["removed"] = [];
  const gapStatements: string[] = [];
  type Part = { kind: "text"; text: string } | { kind: "claim"; claim: Claim };
  const parts: Part[] = [];
  let nextId = 0;

  for (const b of blocks) {
    if (!b.citations.length) {
      if (b.text.trim().startsWith(GAP_PREFIX) || b.text.includes(GAP_PREFIX)) {
        const gap = b.text.slice(b.text.indexOf(GAP_PREFIX)).trim();
        gapStatements.push(gap);
        parts.push({ kind: "text", text: b.text });
      } else if (isConnective(b.text)) {
        parts.push({ kind: "text", text: b.text });
      } else {
        removed.push({ text: b.text.trim(), reason: "uncited" });
      }
      continue;
    }
    const citations: Claim["citations"] = [];
    let mismatch: string | undefined;
    for (const c of b.citations) {
      const chunk = chunks[c.documentIndex];
      if (!chunk || !normalise(chunk.text).includes(normalise(c.citedText))) {
        mismatch = c.citedText.slice(0, 120);
        break;
      }
      citations.push({ chunkId: chunk.id, citedText: c.citedText });
    }
    if (mismatch !== undefined) {
      removed.push({ text: b.text.trim(), reason: "quote_mismatch", detail: mismatch });
      continue;
    }
    parts.push({ kind: "claim", claim: { id: nextId++, text: b.text, citations } });
  }

  const claims = parts.flatMap((p) => (p.kind === "claim" ? [p.claim] : []));
  const verdicts = claims.length
    ? await verify(claims.map((c) => ({ id: c.id, claim: c.text.trim(), quotes: c.citations.map((x) => x.citedText) })))
    : [];
  const rejected = new Map(verdicts.filter((v) => !v.supported).map((v) => [v.id, v.reason]));
  // A claim the verifier did not return a verdict for is treated as unsupported.
  for (const c of claims) if (!verdicts.some((v) => v.id === c.id)) rejected.set(c.id, "no verdict returned");
  for (const c of claims) if (rejected.has(c.id)) removed.push({ text: c.text.trim(), reason: "not_supported", detail: rejected.get(c.id) });

  const kept = claims.filter((c) => !rejected.has(c.id));
  const factual = kept.length + removed.length;
  const removedRatio = factual ? removed.length / factual : 1;

  if (!kept.length || removedRatio > opts.maxRemovedRatio) {
    return { outcome: "refused", markdown: opts.refusalMessage, sources: [], claims: [], removed, gapStatements };
  }

  // Number sources in order of first use and append [n] markers after each claim.
  const sources: Source[] = [];
  const sourceNo = new Map<string, number>();
  const byId = new Map(chunks.map((c) => [c.id, c]));
  let markdown = "";
  for (const p of parts) {
    if (p.kind === "text") {
      markdown += p.text;
      continue;
    }
    if (rejected.has(p.claim.id)) continue;
    const marks = [...new Set(p.claim.citations.map((c) => c.chunkId))].map((chunkId) => {
      if (!sourceNo.has(chunkId)) {
        const ch = byId.get(chunkId)!;
        sourceNo.set(chunkId, sources.length + 1);
        sources.push({
          n: sources.length + 1,
          chunkId,
          documentId: ch.documentId,
          ucId: ch.ucId,
          docType: ch.docType,
          section: ch.section,
          docName: ch.docName,
          webUrl: ch.webUrl,
        });
      }
      return `[${sourceNo.get(chunkId)}]`;
    });
    const text = p.claim.text.replace(/\s+$/, "");
    markdown += `${text} ${marks.join("")}${p.claim.text.slice(text.length)}`;
  }

  return {
    outcome: removed.length || gapStatements.length ? "partial" : "answered",
    markdown: tidy(markdown),
    sources,
    claims: kept,
    removed,
    gapStatements,
  };
}

/** Removes list markers and lead-ins left empty after claims were dropped. */
function tidy(md: string): string {
  return md
    .split("\n")
    .filter((line) => !/^\s*([-*•]|\d+[.)])\s*$/.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
