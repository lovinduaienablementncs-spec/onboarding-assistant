import { useState } from "react";
import { useApi } from "../../api";
import { Loading, num, Stat, usd } from "../../components/ui";
import { BudgetBanner } from "./AdminHome";

interface Totals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
}

interface UsageData {
  byDay: Array<Totals & { day: string }>;
  byModel: Array<Totals & { model: string }>;
  byStep: Array<Totals & { step: string }>;
  byUser: Array<Totals & { userId: string; userName: string | null }>;
  sessions: { sessions: number; avgCostUsd: number; avgTokens: number; refused: number; partial: number };
  promptCacheHitRate: number;
  videoCache: { hits: number; total: number };
}

function TotalsTable<T extends Totals>({ rows, label, name }: { rows: T[]; label: string; name: (r: T) => string }) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0.000001);
  return (
    <table>
      <thead>
        <tr><th>{label}</th><th>Calls</th><th>Input tokens</th><th>Output tokens</th><th>Cache read</th><th>Cost</th><th style={{ width: "25%" }} /></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={name(r)}>
            <td>{name(r)}</td>
            <td>{num(r.calls)}</td>
            <td>{num(r.inputTokens)}</td>
            <td>{num(r.outputTokens)}</td>
            <td>{num(r.cacheReadTokens)}</td>
            <td>{usd(r.costUsd)}</td>
            <td><div className="bar" style={{ width: `${(r.costUsd / max) * 100}%` }} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Usage() {
  const [days, setDays] = useState(30);
  const { data, error, loading } = useApi<UsageData>(`/admin/usage?days=${days}`);

  return (
    <>
      <BudgetBanner />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Usage and cost</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[1, 7, 30, 90].map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (
        <>
          <div className="grid">
            <Stat label="Total cost" value={usd(data.byModel.reduce((n, m) => n + m.costUsd, 0))} />
            <Stat label="Questions" value={num(data.sessions.sessions)} hint={`${data.sessions.refused} refused · ${data.sessions.partial} partial`} />
            <Stat label="Average per question" value={usd(data.sessions.avgCostUsd)} hint={`${num(Math.round(data.sessions.avgTokens))} tokens`} />
            <Stat label="Prompt cache hit rate" value={`${Math.round(data.promptCacheHitRate * 100)}%`} />
            <Stat label="Video cache reuse" value={`${data.videoCache.hits} of ${data.videoCache.total}`} />
          </div>
          <h2>Per day</h2>
          <TotalsTable rows={data.byDay} label="Day" name={(r) => r.day} />
          <h2>Per step</h2>
          <TotalsTable rows={data.byStep} label="Step" name={(r) => r.step} />
          <h2>Per model</h2>
          <TotalsTable rows={data.byModel} label="Model" name={(r) => r.model} />
          <h2>Per user</h2>
          <TotalsTable rows={data.byUser} label="User" name={(r) => r.userName ?? r.userId} />
        </>
      )}
    </>
  );
}
