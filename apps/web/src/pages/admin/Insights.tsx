import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../../api";
import { Loading, when } from "../../components/ui";

interface InsightsData {
  refused: Array<{ traceId: string; question: string; userName: string | null; createdAt: string; reason: string | null }>;
  negativeFeedback: Array<{ messageId: string; answer: string; comment: string | null; traceId: string | null; createdAt: string }>;
  topUseCases: Array<{ ucId: string; count: number }>;
}

const REASONS: Record<string, string> = {
  out_of_scope: "Not about the system",
  low_relevance: "Nothing relevant in the documents",
  model_refusal: "Model declined",
  budget: "Budget limit",
};

export function Insights() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useApi<InsightsData>(`/admin/insights?days=${days}`);

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Insights</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          <h2>Documentation gaps: questions the assistant could not answer</h2>
          <p className="muted small">"Nothing relevant in the documents" usually means a UCS or UIS is missing or does not cover the topic.</p>
          <table>
            <thead><tr><th>When</th><th>Question</th><th>Why</th><th>User</th></tr></thead>
            <tbody>
              {data.refused.map((r) => (
                <tr key={r.traceId}>
                  <td className="small">{when(r.createdAt)}</td>
                  <td><Link to={`/admin/sessions/${r.traceId}`}>{r.question}</Link></td>
                  <td>{REASONS[r.reason ?? ""] ?? r.reason}</td>
                  <td className="small">{r.userName}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Answers marked not helpful</h2>
          <table>
            <thead><tr><th>When</th><th>Answer</th><th>Comment</th></tr></thead>
            <tbody>
              {data.negativeFeedback.map((f) => (
                <tr key={f.messageId + f.createdAt}>
                  <td className="small">{when(f.createdAt)}</td>
                  <td className="small">{f.traceId ? <Link to={`/admin/sessions/${f.traceId}`}>{f.answer.slice(0, 160)}…</Link> : f.answer.slice(0, 160)}</td>
                  <td>{f.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h2>Most-used use cases</h2>
          <table>
            <thead><tr><th>Use case</th><th>Times cited</th></tr></thead>
            <tbody>
              {data.topUseCases.map((u) => (
                <tr key={u.ucId}><td><Link to={`/admin/documents?q=${u.ucId}`}>{u.ucId}</Link></td><td>{u.count}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
