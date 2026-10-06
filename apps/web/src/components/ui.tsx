import type { ReactNode } from "react";

export const Badge = ({ value }: { value: string | null | undefined }) => (value ? <span className={`badge ${value}`}>{value}</span> : null);

export const usd = (n: number | null | undefined) => `$${(n ?? 0).toFixed(n && n < 0.1 ? 4 : 2)}`;
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();
export const when = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

export function Loading({ error, loading }: { error?: string; loading?: boolean }) {
  if (error) return <p className="error">{error}</p>;
  if (loading) return <p className="muted">Loading…</p>;
  return null;
}

export function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
