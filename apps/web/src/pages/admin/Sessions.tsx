import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../../api";
import { Badge, Json, Loading, num, usd, when } from "../../components/ui";

interface Trace {
  id: string;
  kind: string;
  question: string | null;
  userName: string | null;
  userId: string | null;
  outcome: string | null;
  costUsd: number;
  durationMs: number | null;
  createdAt: string;
}

interface Span {
  id: string;
  name: string;
  durationMs: number;
  data: Record<string, unknown>;
  error: string | null;
}

interface Call {
  id: string;
  step: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  units: number;
  costUsd: number;
  latencyMs: number;
  stopReason: string | null;
  error: string | null;
}

export function Sessions() {
  const { traceId } = useParams();
  const [filters, setFilters] = useState({ kind: "chat", outcome: "", q: "" });
  const query = new URLSearchParams({ limit: "100", kind: filters.kind, ...(filters.outcome ? { outcome: filters.outcome } : {}), ...(filters.q ? { q: filters.q } : {}) });
  const { data, error, loading } = useApi<Trace[]>(traceId ? null : `/admin/sessions?${query}`);

  if (traceId) return <TraceView id={traceId} />;
  return (
    <>
      <h1>Sessions</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
          <option value="chat">Questions</option>
          <option value="video">Video renders</option>
          <option value="vision">Screen descriptions</option>
          <option value="video_request">Video requests</option>
        </select>
        <select value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">Any outcome</option>
          {["answered", "partial", "refused", "error", "ok"].map((o) => <option key={o}>{o}</option>)}
        </select>
        <input placeholder="Search question text" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
      </div>
      <Loading error={error} loading={loading && !data} />
      <table>
        <thead>
          <tr><th>When</th><th>User</th><th>Question</th><th>Outcome</th><th>Cost</th><th>Time</th></tr>
        </thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}>
              <td className="small">{when(t.createdAt)}</td>
              <td className="small">{t.userName ?? t.userId ?? "system"}</td>
              <td><Link to={`/admin/sessions/${t.id}`}>{t.question ?? "(no text)"}</Link></td>
              <td><Badge value={t.outcome ?? "running"} /></td>
              <td>{usd(t.costUsd)}</td>
              <td className="small">{t.durationMs ? `${(t.durationMs / 1000).toFixed(1)}s` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** One question as a timeline: what each step decided, then tokens and cost per model call. */
function TraceView({ id }: { id: string }) {
  const { data, error } = useApi<{ trace: Trace; spans: Span[]; calls: Call[]; answer: { content: string; outcome: string } | null }>(`/admin/traces/${id}`);
  if (!data) return <Loading error={error} loading />;
  const { trace, spans, calls, answer } = data;
  const tokens = calls.reduce((n, c) => n + c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens, 0);

  return (
    <>
      <p><Link to="/admin/sessions">← Sessions</Link></p>
      <h1>{trace.question ?? trace.kind}</h1>
      <p className="row">
        <Badge value={trace.outcome} /> <span className="muted small">{trace.userName ?? trace.userId} · {when(trace.createdAt)} · {trace.durationMs ? `${(trace.durationMs / 1000).toFixed(1)}s` : ""}</span>
        <span className="small">· {num(tokens)} tokens · {usd(trace.costUsd)}</span>
      </p>
      <h2>Decision timeline</h2>
      <div className="timeline">
        {spans.map((s) => (
          <div key={s.id} className={`span ${s.error ? "err" : ""}`}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <b>{s.name}</b>
              <span className="muted small">{s.durationMs} ms</span>
            </div>
            <SpanSummary span={s} />
            {s.error && <div className="error small">{s.error}</div>}
            <details>
              <summary className="muted small">details</summary>
              <Json value={s.data} />
            </details>
          </div>
        ))}
      </div>
      {answer && (
        <>
          <h2>Answer shown to the user</h2>
          <div className="card"><pre>{answer.content}</pre></div>
        </>
      )}
      <h2>Model and API calls</h2>
      <table>
        <thead>
          <tr><th>Step</th><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Units</th><th>Cost</th><th>Latency</th><th>Stop</th></tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id}>
              <td>{c.step}</td>
              <td className="small">{c.provider} · {c.model}</td>
              <td>{num(c.inputTokens)}</td>
              <td>{num(c.outputTokens)}</td>
              <td>{num(c.cacheReadTokens)}</td>
              <td>{num(c.cacheWriteTokens)}</td>
              <td>{c.units ? num(c.units) : ""}</td>
              <td>{usd(c.costUsd)}</td>
              <td className="small">{c.latencyMs} ms</td>
              <td className="small">{c.error ? <span className="error">{c.error.slice(0, 80)}</span> : c.stopReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/** A readable one-liner per step so the timeline can be scanned without opening details. */
function SpanSummary({ span: s }: { span: Span }) {
  const d = s.data as Record<string, any>;
  switch (s.name) {
    case "router":
      return <div className="small">Intent <b>{d.intent}</b> for {d.audience} · search “{d.rewrittenQuery}” · {d.reason}</div>;
    case "retrieval":
      return (
        <div className="small">
          {d.candidates?.fused ?? 0} candidates → top:{" "}
          {(d.results as Array<{ ucId: string; section: string; score: number }> | undefined)?.slice(0, 4).map((r) => `${r.ucId ?? "?"} ${r.section} (${r.score})`).join(", ") || "none"}
        </div>
      );
    case "scope_gate":
      return <div className="small">{d.passed ? "Passed" : "Refused"}{d.reason ? ` · ${d.reason}` : ` · top relevance ${d.topScore?.toFixed?.(2)} (min ${d.minRelevance}), ${d.relevant} relevant`}</div>;
    case "answer":
      return <div className="small">{d.model} · {d.citedBlocks}/{d.blocks} blocks cited{d.refused ? " · model refused" : ""}</div>;
    case "grounding":
      return (
        <div className="small">
          <Badge value={d.outcome} /> {d.keptClaims?.length ?? 0} claims kept, {d.removed?.length ?? 0} removed
          {(d.removed as Array<{ text: string; reason: string }> | undefined)?.map((r, i) => (
            <div key={i} className="error">✕ {r.reason}: {r.text.slice(0, 140)}</div>
          ))}
        </div>
      );
    case "video_job":
      return <div className="small">{d.cacheHit ? "Reused an existing video" : d.skipped ? d.skipped : `New video job with ${d.steps} steps, ${d.candidateScreens} candidate screens`}</div>;
    case "budget":
      return <div className="small">Today {usd(d.todayUsd)}, month {usd(d.monthUsd)}, user today {usd(d.userTodayUsd)}</div>;
    default:
      return null;
  }
}
