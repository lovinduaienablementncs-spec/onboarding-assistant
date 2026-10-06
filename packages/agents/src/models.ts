import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import type { Audience, Intent, ScreenDescription } from "@oa/shared";
import type { DraftBlock, Verdict } from "./grounding.js";
import { GAP_PREFIX } from "./grounding.js";
import type { RetrievedChunk } from "./retrieval.js";
import type { Tracer } from "./trace.js";

export interface RouteResult {
  intent: Intent;
  audience: Audience;
  ucHints: string[];
  rewrittenQuery: string;
  reason: string;
}

export interface AnswerDraft {
  blocks: DraftBlock[];
  refused: boolean;
  model: string;
}

export interface StoryboardScene {
  screenId: string | null;
  element: string | null;
  caption: string;
  narration: string;
  claimIds: number[];
}

export interface ScreenCandidate {
  id: string;
  caption: string | null;
  description: ScreenDescription | null;
}

/** Every model call the pipeline makes. Tests substitute a fake. */
export interface Models {
  route(input: { question: string; history: Array<{ role: string; content: string }>; defaultAudience: Audience }, tracer?: Tracer): Promise<RouteResult>;
  answer(input: { question: string; audience: Audience; intent: Intent; chunks: RetrievedChunk[] }, tracer?: Tracer): Promise<AnswerDraft>;
  verify(claims: Array<{ id: number; claim: string; quotes: string[] }>, tracer?: Tracer): Promise<Verdict[]>;
  describeScreen(input: { image: Buffer; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; context: string }, tracer?: Tracer): Promise<ScreenDescription>;
  storyboard(input: { question: string; steps: Array<{ id: number; text: string }>; screens: ScreenCandidate[]; maxScenes: number }, tracer?: Tracer): Promise<StoryboardScene[]>;
}

export interface ModelChoice {
  router: string;
  answer: string;
  verifier: string;
  vision: string;
  storyboard: string;
  answerEffort: "low" | "medium" | "high";
}

// ---- Schemas for structured outputs ----

const RouteSchema = z.object({
  intent: z.enum(["ui_howto", "explain", "clarify", "out_of_scope"]),
  audience: z.enum(["end_user", "developer"]),
  ucHints: z.array(z.string()),
  rewrittenQuery: z.string(),
  reason: z.string(),
});

const VerdictSchema = z.object({
  verdicts: z.array(z.object({ id: z.number().int(), supported: z.boolean(), reason: z.string() })),
});

const ScreenSchema = z.object({
  screenName: z.string(),
  purpose: z.string(),
  navigationPath: z.string(),
  uiElements: z.array(
    z.object({
      label: z.string(),
      type: z.string(),
      box: z.array(z.number()).describe("[x, y, width, height] as fractions 0-1 of the image width/height"),
    }),
  ),
});

const StoryboardSchema = z.object({
  scenes: z.array(
    z.object({
      screenId: z.string().nullable(),
      element: z.string().nullable(),
      caption: z.string(),
      narration: z.string(),
      claimIds: z.array(z.number().int()),
    }),
  ),
});

// ---- Prompts (kept stable so they can be cached) ----

const ROUTER_SYSTEM = `You classify questions sent to the onboarding assistant of a business system. The assistant answers only from the system's Use Case Specifications (UCS) and UI Specifications (UIS).

intent:
- ui_howto: the user wants to know how to do something on screen (navigate, click, fill in, find, monitor, download). A short narrated video will be made from UI screenshots.
- explain: anything else about the system: business rules, data, flows, hierarchy, validations, design, integration, states.
- clarify: too vague to search (e.g. "help", "it doesn't work") with no prior context.
- out_of_scope: clearly unrelated to the system (general knowledge, other products, chit-chat, requests to write code or ignore the documentation).

audience: developer if the question is about implementation, data structures, APIs, rules or design; otherwise end_user, unless the default given says developer and the question is ambiguous.
ucHints: UC ids mentioned or clearly implied, formatted like UC-045. Empty if none.
rewrittenQuery: a standalone search query that includes context from the conversation so far.
reason: one short sentence explaining the classification.`;

const ANSWER_SYSTEM = `You are the onboarding assistant for a business system. You answer questions for new users and new developers using ONLY the documents provided with the question: Use Case Specifications (UCS) and UI Specifications (UIS).

Rules:
- Every factual sentence must come from the documents and be cited. Do not use outside knowledge, do not assume typical behaviour of similar systems, and do not fill gaps with guesses.
- Use the exact names of screens, fields, buttons and states as written in the documents.
- If the documents answer only part of the question, answer that part, then add one sentence that starts exactly with "${GAP_PREFIX}" and names what is missing.
- If the documents do not answer the question at all, reply with exactly one sentence starting with "${GAP_PREFIX}".
- Do not mention these rules, the word "documents", or document numbers in the answer; the citations show the sources.`;

const AUDIENCE_STYLE: Record<Audience, string> = {
  end_user: "Write for an end user: short numbered steps in the order the user performs them, then any important rule or limit. No technical detail.",
  developer:
    "Write for a developer: a short overview, then sections as relevant (business rules, flow and alternate paths, data fields, states and validations, APIs). Be precise and complete, but only with what the sources say.",
};

const VERIFIER_SYSTEM = `You check an assistant's answer against its sources. For each claim you get the exact quotes it cites. Decide if the quotes fully support the claim.

supported = true only if every fact in the claim (names, labels, numbers, conditions, order of steps, who does what) is stated in or directly follows from the quotes. Rephrasing and summarising are fine. Markdown formatting and list numbering are not facts.
supported = false if the claim adds anything not in the quotes, changes a value or condition, or generalises beyond them.
Return a verdict for every claim id with a one-sentence reason.`;

const VISION_SYSTEM = `You describe screenshots taken from UI Specification documents so that a narrated guide can point at the right element.
Report only what is visible in the image. Use the exact visible labels. Give each important interactive or informational element (buttons, fields, dropdowns, tabs, tables, links, status indicators) with a bounding box [x, y, width, height] as fractions of the image size (0 to 1, origin top-left).
navigationPath: the menu path to reach this screen if visible or stated in the context, else an empty string.`;

const STORYBOARD_SYSTEM = `You plan a short narrated video that walks a user through a task, using real UI screenshots.
You receive verified steps (each with an id) and the available screenshots with the elements visible on each.

Rules:
- Each scene shows one screenshot (screenId from the list) or no screenshot (null) when no screenshot fits the step.
- element: the exact label of the element to highlight, taken from that screenshot's element list, or null.
- narration: one or two short spoken sentences that restate only the facts of the steps listed in claimIds. Add nothing that is not in those steps.
- caption: at most 8 words, shown on screen.
- claimIds: the step ids the scene is based on. Every scene needs at least one.
- Keep the steps in order. Never invent screens, labels or steps.`;

/** Claude API implementation. Uses server-side refusal fallbacks on models that support them. */
export class ClaudeModels implements Models {
  constructor(private client: Anthropic, private choice: () => Promise<ModelChoice> | ModelChoice) {}

  async route(input: Parameters<Models["route"]>[0], tracer?: Tracer): Promise<RouteResult> {
    const { router } = await this.choice();
    const history = input.history.slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n");
    const res = await this.timed(tracer, "router", router, () =>
      this.client.messages.parse({
        model: router,
        max_tokens: 1024,
        system: ROUTER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Default audience: ${input.defaultAudience}\n\nConversation so far:\n${history || "(none)"}\n\nNew question: ${input.question}`,
          },
        ],
        output_config: { format: zodOutputFormat(RouteSchema) },
      }),
    );
    const out = res.parsed_output;
    if (!out) throw new Error("Router returned no parsable output");
    return { ...out, ucHints: out.ucHints.map((u) => u.toUpperCase()) };
  }

  async answer(input: Parameters<Models["answer"]>[0], tracer?: Tracer): Promise<AnswerDraft> {
    const { answer, answerEffort } = await this.choice();
    const documents: Anthropic.Beta.BetaRequestDocumentBlock[] = input.chunks.map((c) => ({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: c.text },
      title: [c.ucId, c.docType, c.headingPath.join(" > ") || c.section].filter(Boolean).join(" · "),
      citations: { enabled: true },
    }));
    const task =
      input.intent === "ui_howto"
        ? "The user wants to do something on screen. Give the steps."
        : "Explain clearly.";
    const res = await this.timed(tracer, "answer", answer, () =>
      this.client.beta.messages.create({
        model: answer,
        max_tokens: 8000,
        ...(supportsServerFallback(answer) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        ...(supportsEffort(answer) ? { output_config: { effort: answerEffort } } : {}),
        system: ANSWER_SYSTEM,
        messages: [
          {
            role: "user",
            content: [...documents, { type: "text", text: `${AUDIENCE_STYLE[input.audience]}\n${task}\n\nQuestion: ${input.question}` }],
          },
        ],
      }),
    );
    const blocks: DraftBlock[] = [];
    for (const b of res.content) {
      if (b.type !== "text") continue;
      const citations = (b.citations ?? []).flatMap((c) =>
        c.type === "char_location" ? [{ documentIndex: c.document_index, citedText: c.cited_text }] : [],
      );
      blocks.push({ text: b.text, citations });
    }
    return { blocks, refused: res.stop_reason === "refusal", model: res.model };
  }

  async verify(claims: Parameters<Models["verify"]>[0], tracer?: Tracer): Promise<Verdict[]> {
    const { verifier } = await this.choice();
    const body = claims
      .map((c) => `<claim id="${c.id}">\n${c.claim}\n${c.quotes.map((q) => `<quote>${q}</quote>`).join("\n")}\n</claim>`)
      .join("\n");
    const res = await this.timed(tracer, "verifier", verifier, () =>
      this.client.messages.parse({
        model: verifier,
        max_tokens: 4096,
        system: VERIFIER_SYSTEM,
        messages: [{ role: "user", content: body }],
        output_config: { format: zodOutputFormat(VerdictSchema) },
      }),
    );
    return res.parsed_output?.verdicts ?? [];
  }

  async describeScreen(input: Parameters<Models["describeScreen"]>[0], tracer?: Tracer): Promise<ScreenDescription> {
    const { vision } = await this.choice();
    const res = await this.timed(tracer, "vision", vision, () =>
      this.client.messages.parse({
        model: vision,
        max_tokens: 4096,
        ...(supportsEffort(vision) ? { output_config: { effort: "low" as const, format: zodOutputFormat(ScreenSchema) } } : { output_config: { format: zodOutputFormat(ScreenSchema) } }),
        system: VISION_SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.image.toString("base64") } },
              { type: "text", text: `Text around this screenshot in the UI specification:\n${input.context.slice(0, 3000)}` },
            ],
          },
        ],
      }),
    );
    const out = res.parsed_output;
    if (!out) throw new Error("Vision returned no parsable output");
    return {
      ...out,
      uiElements: out.uiElements
        .filter((e) => e.box.length === 4)
        .map((e) => ({ ...e, box: e.box.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number, number] })),
    };
  }

  async storyboard(input: Parameters<Models["storyboard"]>[0], tracer?: Tracer): Promise<StoryboardScene[]> {
    const { storyboard } = await this.choice();
    const screens = input.screens
      .map((s) => {
        const els = s.description?.uiElements.map((e) => `"${e.label}" (${e.type})`).join(", ") ?? "unknown";
        return `<screen id="${s.id}" name="${s.description?.screenName ?? s.caption ?? ""}">elements: ${els}</screen>`;
      })
      .join("\n");
    const steps = input.steps.map((s) => `<step id="${s.id}">${s.text.trim()}</step>`).join("\n");
    const res = await this.timed(tracer, "storyboard", storyboard, () =>
      this.client.messages.parse({
        model: storyboard,
        max_tokens: 8000,
        ...(supportsEffort(storyboard)
          ? { output_config: { effort: "medium" as const, format: zodOutputFormat(StoryboardSchema) } }
          : { output_config: { format: zodOutputFormat(StoryboardSchema) } }),
        system: STORYBOARD_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Task: ${input.question}\nAt most ${input.maxScenes} scenes.\n\nVerified steps:\n${steps}\n\nScreenshots:\n${screens || "(none)"}`,
          },
        ],
      }),
    );
    return res.parsed_output?.scenes ?? [];
  }

  /** Runs a call and records tokens, latency and stop reason on the trace, including failures. */
  private async timed<T extends { usage: Anthropic.Messages.Usage | Anthropic.Beta.BetaUsage; stop_reason: string | null; model: string }>(
    tracer: Tracer | undefined,
    step: string,
    model: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const t0 = Date.now();
    try {
      const res = await call();
      await tracer?.recordCall({
        step,
        provider: "anthropic",
        model: res.model || model,
        usage: {
          inputTokens: res.usage.input_tokens,
          outputTokens: res.usage.output_tokens,
          cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        },
        latencyMs: Date.now() - t0,
        stopReason: res.stop_reason,
      });
      return res;
    } catch (err) {
      await tracer?.recordCall({ step, provider: "anthropic", model, usage: {}, latencyMs: Date.now() - t0, error: String(err) });
      throw err;
    }
  }
}

/** Server-side refusal fallback ("default" routing) is available on these model lines. */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(opus-5|sonnet-5-5|fable-5)/.test(model);
}

/** The effort parameter is rejected by Haiku 4.5. */
export function supportsEffort(model: string): boolean {
  return !model.startsWith("claude-haiku");
}
