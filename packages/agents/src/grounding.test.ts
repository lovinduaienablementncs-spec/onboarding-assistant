import { describe, expect, it } from "vitest";
import { GAP_PREFIX, groundAnswer, isConnective, type DraftBlock, type Verify } from "./grounding.js";
import type { RetrievedChunk } from "./retrieval.js";

const chunk = (id: string, text: string, ucId = "UC-045"): RetrievedChunk => ({
  id,
  documentId: `doc-${id}`,
  ucId,
  docType: "UIS",
  section: "Filters",
  headingPath: ["3. Filters"],
  text,
  docName: "UC-045.docx",
  webUrl: `file:///UC-045.docx#${id}`,
  docVersion: 1,
  score: 0.9,
});

const CHUNKS = [
  chunk("c1", "The Tax Year Filter is a dropdown. It defaults to the current tax year."),
  chunk("c2", "Click Search to list notices. Notices are shown in reverse chronological order."),
];
const OPTS = { maxRemovedRatio: 0.3, refusalMessage: "REFUSED" };
const allSupported: Verify = async (claims) => claims.map((c) => ({ id: c.id, supported: true, reason: "ok" }));
const cite = (documentIndex: number, citedText: string) => ({ documentIndex, citedText });

describe("isConnective", () => {
  it("keeps formatting and lead-ins but not facts", () => {
    for (const t of ["\n\n", "1. ", "- ", "## Steps", "To filter notices:", "**Steps:**"]) expect(isConnective(t), t).toBe(true);
    for (const t of ["The portal times out after 15 minutes.", "Use the Export button to download a CSV file of all notices."]) {
      expect(isConnective(t), t).toBe(false);
    }
  });
});

describe("groundAnswer", () => {
  it("keeps cited claims, numbers sources and keeps formatting", async () => {
    const blocks: DraftBlock[] = [
      { text: "To find a notice:\n\n1. ", citations: [] },
      { text: "Choose a year in the Tax Year Filter dropdown; it starts on the current tax year.", citations: [cite(0, "The Tax Year Filter is a dropdown. It defaults to the current tax year.")] },
      { text: "\n2. ", citations: [] },
      { text: "Click Search; notices appear newest first.", citations: [cite(1, "Click Search to list notices. Notices are shown in reverse chronological order.")] },
    ];
    const g = await groundAnswer(blocks, CHUNKS, allSupported, OPTS);

    expect(g.outcome).toBe("answered");
    expect(g.markdown).toBe(
      "To find a notice:\n\n1. Choose a year in the Tax Year Filter dropdown; it starts on the current tax year. [1]\n2. Click Search; notices appear newest first. [2]",
    );
    expect(g.sources.map((s) => [s.n, s.chunkId])).toEqual([[1, "c1"], [2, "c2"]]);
    expect(g.claims).toHaveLength(2);
  });

  it("drops uncited factual sentences (no outside knowledge) and marks the answer partial", async () => {
    const blocks: DraftBlock[] = Array.from({ length: 4 }, (_, i) => ({
      text: `Fact ${i} from the filter section.`,
      citations: [cite(0, "The Tax Year Filter is a dropdown.")],
    }));
    blocks.push({ text: " Notices older than 7 years are archived automatically.", citations: [] });
    const g = await groundAnswer(blocks, CHUNKS, allSupported, OPTS);

    expect(g.outcome).toBe("partial");
    expect(g.markdown).not.toContain("archived");
    expect(g.removed).toEqual([{ text: "Notices older than 7 years are archived automatically.", reason: "uncited" }]);
  });

  it("drops a claim whose quote is not literally in the cited chunk", async () => {
    const blocks: DraftBlock[] = [
      { text: "Defaults to the current year.", citations: [cite(0, "It defaults to the current tax year.")] },
      { text: "Defaults to the current year.", citations: [cite(0, "The Tax Year Filter is a dropdown.")] },
      { text: "Defaults to the current year.", citations: [cite(0, "The Tax Year Filter is a dropdown.")] },
      { text: "Search is instant.", citations: [cite(1, "Search returns results within 2 seconds.")] },
    ];
    const g = await groundAnswer(blocks, CHUNKS, allSupported, OPTS);
    expect(g.removed).toEqual([{ text: "Search is instant.", reason: "quote_mismatch", detail: "Search returns results within 2 seconds." }]);
    expect(g.markdown).not.toContain("instant");
  });

  it("drops claims the verifier rejects, and claims with no verdict", async () => {
    const blocks: DraftBlock[] = [0, 1, 2, 3].map((i) => ({ text: `Claim ${i}.`, citations: [cite(0, "The Tax Year Filter is a dropdown.")] }));
    const verify: Verify = async (claims) => claims.filter((c) => c.id !== 3).map((c) => ({ id: c.id, supported: c.id !== 1, reason: c.id === 1 ? "adds a value" : "ok" }));
    const g = await groundAnswer(blocks, CHUNKS, verify, { ...OPTS, maxRemovedRatio: 0.6 });

    expect(g.claims.map((c) => c.id)).toEqual([0, 2]);
    expect(g.removed.map((r) => [r.text, r.reason, r.detail])).toEqual([
      ["Claim 1.", "not_supported", "adds a value"],
      ["Claim 3.", "not_supported", "no verdict returned"],
    ]);
  });

  it("refuses when too much had to be removed", async () => {
    const blocks: DraftBlock[] = [
      { text: "Supported claim.", citations: [cite(0, "The Tax Year Filter is a dropdown.")] },
      { text: "Invented claim one.", citations: [] },
      { text: "Invented claim two.", citations: [] },
    ];
    const g = await groundAnswer(blocks, CHUNKS, allSupported, OPTS);
    expect(g).toMatchObject({ outcome: "refused", markdown: "REFUSED", sources: [], claims: [] });
  });

  it("refuses when the model only says the topic is not covered", async () => {
    const g = await groundAnswer([{ text: `${GAP_PREFIX} payment refunds.`, citations: [] }], CHUNKS, allSupported, OPTS);
    expect(g.outcome).toBe("refused");
  });

  it("keeps an explicit gap statement alongside a grounded answer", async () => {
    const blocks: DraftBlock[] = [
      { text: "The Tax Year Filter is a dropdown.", citations: [cite(0, "The Tax Year Filter is a dropdown.")] },
      { text: ` ${GAP_PREFIX} how to download several notices at once.`, citations: [] },
    ];
    const g = await groundAnswer(blocks, CHUNKS, allSupported, OPTS);
    expect(g.outcome).toBe("partial");
    expect(g.gapStatements).toEqual([`${GAP_PREFIX} how to download several notices at once.`]);
    expect(g.markdown).toContain(GAP_PREFIX);
  });
});
