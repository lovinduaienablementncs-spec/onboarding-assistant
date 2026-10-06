import type { AnswerDraft, Models, Reranker, RouteResult, StoryboardScene, Tracer } from "@oa/agents";
import type { ScreenDescription } from "@oa/shared";

/**
 * Stand-in for Claude. It answers by citing the first sentence of each chunk
 * it is given, records token usage like the real client, and counts calls so
 * tests can assert which models were (not) called.
 */
export class FakeModels implements Models {
  calls = { route: 0, answer: 0, verify: 0, describeScreen: 0, storyboard: 0 };
  routeResult: Partial<RouteResult> = {};
  /** Extra uncited sentence appended to every answer, to test grounding. */
  inventedSentence?: string;
  storyboardScenes?: StoryboardScene[];
  rejectClaimsContaining?: string;

  async route(input: Parameters<Models["route"]>[0], tracer?: Tracer): Promise<RouteResult> {
    this.calls.route++;
    await tracer?.recordCall({ step: "router", provider: "anthropic", model: "claude-haiku-4-5", usage: { inputTokens: 300, outputTokens: 60 }, latencyMs: 1 });
    return { intent: "explain", audience: input.defaultAudience, ucHints: [], rewrittenQuery: input.question, reason: "fake", ...this.routeResult };
  }

  async answer(input: Parameters<Models["answer"]>[0], tracer?: Tracer): Promise<AnswerDraft> {
    this.calls.answer++;
    await tracer?.recordCall({ step: "answer", provider: "anthropic", model: "claude-opus-5-5", usage: { inputTokens: 1000, outputTokens: 500 }, latencyMs: 1 });
    const blocks: AnswerDraft["blocks"] = input.chunks.slice(0, 3).flatMap((c, i) => {
      const first = c.text.split(/(?<=\.)\s/)[0]!;
      return [
        { text: `${i + 1}. `, citations: [] },
        { text: first, citations: [{ documentIndex: i, citedText: first }] },
        { text: "\n", citations: [] },
      ];
    });
    if (this.inventedSentence) blocks.push({ text: this.inventedSentence, citations: [] });
    return { blocks, refused: false, model: "claude-opus-5-5" };
  }

  async verify(claims: Parameters<Models["verify"]>[0], tracer?: Tracer) {
    this.calls.verify++;
    await tracer?.recordCall({ step: "verifier", provider: "anthropic", model: "claude-haiku-4-5", usage: { inputTokens: 400, outputTokens: 80 }, latencyMs: 1 });
    return claims.map((c) => ({
      id: c.id,
      supported: !(this.rejectClaimsContaining && c.claim.includes(this.rejectClaimsContaining)),
      reason: "fake",
    }));
  }

  async describeScreen(): Promise<ScreenDescription> {
    this.calls.describeScreen++;
    return { screenName: "Submission Monitor", purpose: "Monitor batches", navigationPath: "", uiElements: [{ label: "Reprocess Failed", type: "button", box: [0.7, 0.1, 0.2, 0.08] }] };
  }

  async storyboard(input: Parameters<Models["storyboard"]>[0]): Promise<StoryboardScene[]> {
    this.calls.storyboard++;
    return (
      this.storyboardScenes ??
      input.steps.map((s, i) => ({
        screenId: input.screens[i % Math.max(1, input.screens.length)]?.id ?? null,
        element: input.screens[0]?.description?.uiElements[0]?.label ?? null,
        caption: "Step",
        narration: s.text,
        claimIds: [s.id],
      }))
    );
  }
}

/** Scores a chunk by the share of query words it contains, so relevance is predictable in tests. */
export class KeywordReranker implements Reranker {
  async rerank(query: string, docs: string[], topK: number) {
    const words = query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
    const results = docs
      .map((d, index) => {
        const text = d.toLowerCase();
        const hits = words.filter((w) => text.includes(w)).length;
        return { index, score: words.length ? hits / words.length : 0 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return { results, tokens: 100, model: "rerank-2.5" };
  }
}
