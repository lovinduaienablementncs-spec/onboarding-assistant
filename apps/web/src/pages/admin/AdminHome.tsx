import { Link } from "react-router-dom";
import { useApi } from "../../api";
import { Badge, Stat, usd, when } from "../../components/ui";

export interface Budget {
  todayUsd: number;
  monthUsd: number;
  limits: { dailyUsd: number; monthlyUsd: number; perUserDailyUsd: number };
  level: "ok" | "warning" | "blocked";
}

export function BudgetBanner() {
  const { data } = useApi<Budget>("/admin/budget");
  if (!data || data.level === "ok") return null;
  return (
    <div className={`banner ${data.level}`}>
      {data.level === "blocked" ? "Budget limit reached: new questions are being declined." : "Spending is above 80% of a budget limit."} Today {usd(data.todayUsd)} of{" "}
      {usd(data.limits.dailyUsd)}, this month {usd(data.monthUsd)} of {usd(data.limits.monthlyUsd)}.
    </div>
  );
}

export function AdminHome() {
  const { data: budget } = useApi<Budget>("/admin/budget");
  const { data: docs } = useApi<{ total: number }>("/admin/documents?limit=1");
  const { data: failed } = useApi<{ total: number }>("/admin/documents?status=failed&limit=1");
  const { data: runs } = useApi<Array<{ id: string; status: string; trigger: string; startedAt: string; added: number; updated: number; deleted: number; failed: number }>>("/admin/crawl-runs?limit=5");
  const { data: usage } = useApi<{ sessions: { sessions: number; refused: number; partial: number; avgCostUsd: number } }>("/admin/usage?days=7");
  const { data: pending } = useApi<unknown[]>("/admin/screens?status=pending&limit=200");

  return (
    <>
      <BudgetBanner />
      <h1>Overview</h1>
      <div className="grid">
        <Stat label="Indexed documents" value={docs?.total ?? "—"} hint={failed?.total ? <Link to="/admin/documents?status=failed">{failed.total} failed</Link> : "none failed"} />
        <Stat label="Questions (7 days)" value={usage?.sessions.sessions ?? "—"} hint={usage ? `${usage.sessions.refused} refused · ${usage.sessions.partial} partial` : ""} />
        <Stat label="Spend today" value={usd(budget?.todayUsd)} hint={budget ? `limit ${usd(budget.limits.dailyUsd)}` : ""} />
        <Stat label="Spend this month" value={usd(budget?.monthUsd)} hint={budget ? `limit ${usd(budget.limits.monthlyUsd)}` : ""} />
        <Stat label="Screens waiting for description" value={pending?.length ?? "—"} />
      </div>
      <h2>Recent crawls</h2>
      <table>
        <thead>
          <tr><th>Started</th><th>Trigger</th><th>Status</th><th>Added</th><th>Updated</th><th>Deleted</th><th>Failed</th></tr>
        </thead>
        <tbody>
          {runs?.map((r) => (
            <tr key={r.id}>
              <td>{when(r.startedAt)}</td><td>{r.trigger}</td><td><Badge value={r.status} /></td>
              <td>{r.added}</td><td>{r.updated}</td><td>{r.deleted}</td><td>{r.failed}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
