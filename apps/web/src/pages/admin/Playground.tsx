import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api";
import { Badge, Json, num, usd } from "../../components/ui";

interface Result {
  traceId?: string;
  events: Array<{ type: string; outcome?: string; markdown?: string }>;
  spans: Array<{ id: string; name: string; durationMs: number; data: Record<string, unknown> }>;
  calls: Array<{ step: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}

/** Runs the real pipeline so thresholds can be tuned against real questions before saving settings. */
export function Playground() {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api<Result>("/admin/playground", { method: "POST", body: { question } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const answer = result?.events.find((e) => e.type === "answer");
  const retrieval = result?.spans.find((s) => s.name === "retrieval")?.data.results as Array<{ ucId: string; section: string; score: number }> | undefined;
  const gate = result?.spans.filter((s) => s.name === "scope_gate").at(-1)?.data;

  return (
    <>
      <h1>Playground</h1>
      <p className="muted">Ask a test question and see each decision. It uses the saved settings and counts toward usage.</p>
      <div className="row">
        <input style={{ flex: 1 }} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Type a question" onKeyDown={(e) => e.key === "Enter" && void run()} />
        <button className="primary" disabled={!question || busy} onClick={() => void run()}>{busy ? "Running…" : "Run"}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {result && (
        <>
          <h2>Answer <Badge value={answer?.outcome} /></h2>
          <div className="card"><pre>{answer?.markdown}</pre></div>
          {result.traceId && <p className="small"><Link to={`/admin/sessions/${result.traceId}`}>Open full trace</Link></p>}
          <h2>Retrieved sections and relevance</h2>
          {gate && <p className="small">Scope gate: {gate.passed ? "passed" : "refused"} (minimum relevance {String(gate.minRelevance ?? "—")})</p>}
          <table>
            <thead><tr><th>Use case</th><th>Section</th><th>Relevance</th><th style={{ width: "40%" }} /></tr></thead>
            <tbody>
              {retrieval?.map((r, i) => (
                <tr key={i}>
                  <td>{r.ucId}</td><td>{r.section}</td><td>{r.score}</td>
                  <td><div className="bar" style={{ width: `${r.score * 100}%`, background: Number(gate?.minRelevance ?? 0) > r.score ? "var(--bad)" : undefined }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Grounding</h2>
          <Json value={result.spans.find((s) => s.name === "grounding")?.data ?? "Not reached"} />
          <h2>Calls</h2>
          <table>
            <thead><tr><th>Step</th><th>Model</th><th>Input</th><th>Output</th><th>Cost</th></tr></thead>
            <tbody>
              {result.calls.map((c, i) => (
                <tr key={i}><td>{c.step}</td><td>{c.model}</td><td>{num(c.inputTokens)}</td><td>{num(c.outputTokens)}</td><td>{usd(c.costUsd)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
