import { env } from "@oa/shared";

export interface EmbedResult {
  vectors: number[][];
  tokens: number;
}

export interface Embedder {
  embed(texts: string[], inputType: "document" | "query"): Promise<EmbedResult>;
}

const BATCH = 64;

export class VoyageEmbedder implements Embedder {
  constructor(
    private apiKey = env.voyageApiKey,
    private model = env.embeddingModel,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async embed(texts: string[], inputType: "document" | "query"): Promise<EmbedResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = await this.post({ input: texts.slice(i, i + BATCH), model: this.model, input_type: inputType });
      const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage: { total_tokens: number } };
      for (const d of body.data.sort((a, b) => a.index - b.index)) vectors.push(d.embedding);
      tokens += body.usage.total_tokens;
    }
    return { vectors, tokens };
  }

  private async post(payload: unknown, attempt = 1): Promise<Response> {
    const res = await this.fetchImpl("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      return this.post(payload, attempt + 1);
    }
    if (!res.ok) throw new Error(`Voyage ${res.status}: ${await res.text()}`);
    return res;
  }
}
