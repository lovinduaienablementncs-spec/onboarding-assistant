import { and, cosineDistance, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { chunks, documents, type Db } from "@oa/db";
import { chunkHeader, type Embedder } from "@oa/ingestion";
import { env } from "@oa/shared";
import type { Tracer } from "./trace.js";

export interface RetrievedChunk {
  id: string;
  documentId: string;
  ucId: string | null;
  docType: string;
  section: string;
  headingPath: string[];
  text: string;
  docName: string;
  webUrl: string;
  docVersion: number;
  /** Rerank relevance, 0-1. */
  score: number;
}

export interface Reranker {
  rerank(query: string, docs: string[], topK: number): Promise<{ results: Array<{ index: number; score: number }>; tokens: number; model: string }>;
}

export class VoyageReranker implements Reranker {
  constructor(private apiKey = env.voyageApiKey, private model = "rerank-2.5", private fetchImpl: typeof fetch = fetch) {}

  async rerank(query: string, docs: string[], topK: number) {
    const res = await this.fetchImpl("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, documents: docs, model: this.model, top_k: topK }),
    });
    if (!res.ok) throw new Error(`Voyage rerank ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: Array<{ index: number; relevance_score: number }>; usage: { total_tokens: number } };
    return {
      results: body.data.map((d) => ({ index: d.index, score: d.relevance_score })),
      tokens: body.usage.total_tokens,
      model: this.model,
    };
  }
}

export interface SearchOptions {
  topK: number;
  /** UC ids the router thinks the question is about; their chunks join the candidate pool. */
  ucHints?: string[];
  /** When set, only documents with an empty ACL or one of these principals are searched. */
  principals?: string[];
}

const POOL = 30;
const RRF_K = 60;

/**
 * Hybrid search: pgvector cosine similarity and Postgres full-text rank are
 * merged with reciprocal rank fusion, then reranked. Full-text matters for
 * exact terms such as UC ids, field names and button labels.
 */
export class Retriever {
  constructor(private db: Db, private embedder: Embedder, private reranker: Reranker) {}

  async search(query: string, opts: SearchOptions, tracer?: Tracer): Promise<RetrievedChunk[]> {
    const run = async (data: Record<string, unknown>) => {
      const t0 = Date.now();
      const { vectors, tokens } = await this.embedder.embed([query], "query");
      await tracer?.recordCall({ step: "embed_query", provider: "voyage", model: env.embeddingModel, usage: { inputTokens: tokens }, latencyMs: Date.now() - t0 });
      const qvec = vectors[0]!;

      const visible = and(
        isNull(documents.deletedAt),
        opts.principals ? sql`(jsonb_array_length(documents.acl) = 0 or documents.acl ?| ${opts.principals}::text[])` : undefined,
      );
      const fields = {
        id: chunks.id,
        documentId: chunks.documentId,
        ucId: chunks.ucId,
        docType: chunks.docType,
        section: chunks.section,
        headingPath: chunks.headingPath,
        text: chunks.text,
        docName: documents.name,
        webUrl: documents.webUrl,
        docVersion: documents.version,
      };
      const base = () => this.db.select(fields).from(chunks).innerJoin(documents, eq(documents.id, chunks.documentId));

      const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
      const [byVector, byText, byHint] = await Promise.all([
        base()
          .where(and(visible, isNotNull(chunks.embedding)))
          .orderBy(cosineDistance(chunks.embedding, qvec))
          .limit(POOL),
        base()
          .where(and(visible, sql`chunks.tsv @@ ${tsQuery}`))
          .orderBy(desc(sql`ts_rank_cd(chunks.tsv, ${tsQuery})`))
          .limit(POOL),
        opts.ucHints?.length
          ? base()
              .where(and(visible, inArray(chunks.ucId, opts.ucHints), isNotNull(chunks.embedding)) as SQL)
              .orderBy(cosineDistance(chunks.embedding, qvec))
              .limit(10)
          : Promise.resolve([]),
      ]);

      // Reciprocal rank fusion.
      const fused = new Map<string, { row: (typeof byVector)[number]; score: number }>();
      for (const list of [byVector, byText, byHint]) {
        list.forEach((row, rank) => {
          const prev = fused.get(row.id);
          fused.set(row.id, { row, score: (prev?.score ?? 0) + 1 / (RRF_K + rank + 1) });
        });
      }
      const candidates = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, POOL).map((f) => f.row);
      data.query = query;
      data.candidates = { vector: byVector.length, keyword: byText.length, ucHint: byHint.length, fused: candidates.length };
      if (!candidates.length) {
        data.results = [];
        return [];
      }

      const t1 = Date.now();
      const ranked = await this.reranker.rerank(
        query,
        candidates.map((c) => `${chunkHeader({ ucId: c.ucId, docType: c.docType as "UCS", headingPath: c.headingPath })}\n${c.text}`),
        Math.min(opts.topK, candidates.length),
      );
      await tracer?.recordCall({ step: "rerank", provider: "voyage", model: ranked.model, usage: { inputTokens: ranked.tokens }, latencyMs: Date.now() - t1 });

      const results = ranked.results.map((r) => ({ ...candidates[r.index]!, score: r.score }));
      data.results = results.map((r) => ({ chunkId: r.id, ucId: r.ucId, docType: r.docType, section: r.section, score: Number(r.score.toFixed(4)) }));
      return results;
    };
    return tracer ? tracer.span("retrieval", run) : run({});
  }
}
