import { eq, sql } from "drizzle-orm";
import { llmCalls, modelPrices, spans, traces, type Db } from "@oa/db";

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Non-token units, e.g. TTS characters. */
  units?: number;
}

interface Price {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

const PRICE_TTL_MS = 60_000;
let priceCache: { at: number; prices: Map<string, Price> } | null = null;

async function prices(db: Db): Promise<Map<string, Price>> {
  if (priceCache && Date.now() - priceCache.at < PRICE_TTL_MS) return priceCache.prices;
  const rows = await db.select().from(modelPrices);
  priceCache = { at: Date.now(), prices: new Map(rows.map((r) => [r.model, r])) };
  return priceCache.prices;
}

export function costOf(price: Price | undefined, u: Usage): number {
  if (!price) return 0;
  return (
    ((u.inputTokens ?? 0) + (u.units ?? 0)) * price.inputPerM +
    (u.outputTokens ?? 0) * price.outputPerM +
    (u.cacheReadTokens ?? 0) * price.cacheReadPerM +
    (u.cacheWriteTokens ?? 0) * price.cacheWritePerM
  ) / 1_000_000;
}

/**
 * Records one trace: a span per pipeline step (its structured inputs and
 * decisions) and every model call with tokens and cost. The model's own
 * reasoning is never stored; steps log their explicit outputs.
 */
export class Tracer {
  readonly id: string;
  private ordinal = 0;
  private started = Date.now();
  private cost = 0;
  private ready: Promise<void>;
  private userId?: string;

  constructor(
    private db: Db,
    meta: { kind: string; conversationId?: string; userId?: string; userName?: string; question?: string },
    id?: string,
  ) {
    this.id = id ?? crypto.randomUUID();
    this.userId = meta.userId;
    this.ready = db
      .insert(traces)
      .values({ id: this.id, ...meta })
      .then(() => undefined);
  }

  /** Runs a step and records it; `data` is filled in by the step with what it decided. */
  async span<T>(name: string, fn: (data: Record<string, unknown>) => Promise<T>): Promise<T> {
    const data: Record<string, unknown> = {};
    const startedAt = new Date();
    const ordinal = this.ordinal++;
    let error: string | undefined;
    try {
      return await fn(data);
    } catch (err) {
      error = String(err);
      throw err;
    } finally {
      await this.ready;
      await this.db.insert(spans).values({
        traceId: this.id,
        name,
        ordinal,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
        data,
        error,
      });
    }
  }

  async recordCall(c: { step: string; provider: string; model: string; usage: Usage; latencyMs: number; stopReason?: string | null; error?: string; userId?: string }) {
    const costUsd = costOf((await prices(this.db)).get(c.model), c.usage);
    this.cost += costUsd;
    await this.ready;
    await this.db.insert(llmCalls).values({
      traceId: this.id,
      userId: c.userId ?? this.userId,
      step: c.step,
      provider: c.provider,
      model: c.model,
      inputTokens: c.usage.inputTokens ?? 0,
      outputTokens: c.usage.outputTokens ?? 0,
      cacheReadTokens: c.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: c.usage.cacheWriteTokens ?? 0,
      units: c.usage.units ?? 0,
      costUsd,
      latencyMs: c.latencyMs,
      stopReason: c.stopReason ?? null,
      error: c.error,
    });
  }

  async finish(outcome: string) {
    await this.ready;
    await this.db
      .update(traces)
      .set({
        outcome,
        costUsd: sql`(select coalesce(sum(llm_calls.cost_usd), 0) from llm_calls where llm_calls.trace_id = ${this.id})`,
        durationMs: Date.now() - this.started,
      })
      .where(eq(traces.id, this.id));
  }

  get costUsd() {
    return this.cost;
  }
}
