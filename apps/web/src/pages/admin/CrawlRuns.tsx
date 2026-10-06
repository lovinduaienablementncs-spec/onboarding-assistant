import { Fragment, useState } from "react";
import { api, useApi } from "../../api";
import { Badge, Loading, num, when } from "../../components/ui";

interface Run {
  id: string;
  sourceId: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  failed: number;
  embeddingTokens: number;
  error: string | null;
}

interface Item {
  id: string;
  path: string;
  action: string;
  status: string;
  attempts: number;
  error: string | null;
}

export function CrawlRuns({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = useApi<Run[]>("/admin/crawl-runs?limit=50");
  const [open, setOpen] = useState<string>();
  const { data: items } = useApi<Item[]>(open ? `/admin/crawl-runs/${open}/items?limit=200` : null);
  const [message, setMessage] = useState<string>();

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Crawl jobs</h1>
        <button onClick={() => void reload()}>Refresh</button>
      </div>
      {message && <p className="muted">{message}</p>}
      <Loading error={error} loading={loading && !data} />
      <table>
        <thead>
          <tr><th>Started</th><th>Trigger</th><th>Status</th><th>Added</th><th>Updated</th><th>Deleted</th><th>Unchanged</th><th>Failed</th><th>Embedding tokens</th><th>Duration</th></tr>
        </thead>
        <tbody>
          {data?.map((r) => (
            <Fragment key={r.id}>
              <tr className="clickable" onClick={() => setOpen(open === r.id ? undefined : r.id)}>
                <td>{when(r.startedAt)}</td>
                <td>{r.trigger}</td>
                <td><Badge value={r.status} />{r.error && <div className="error small">{r.error}</div>}</td>
                <td>{r.added}</td><td>{r.updated}</td><td>{r.deleted}</td><td>{r.unchanged}</td>
                <td>{r.failed ? <span className="error">{r.failed}</span> : 0}</td>
                <td>{num(r.embeddingTokens)}</td>
                <td>{r.finishedAt ? `${Math.round((+new Date(r.finishedAt) - +new Date(r.startedAt)) / 1000)}s` : "running"}</td>
              </tr>
              {open === r.id && (
                <tr>
                  <td colSpan={10}>
                    {isAdmin && r.failed > 0 && (
                      <button
                        style={{ marginBottom: 8 }}
                        onClick={() => void api<{ queued: number }>(`/admin/crawl-runs/${r.id}/retry-failed`, { method: "POST" }).then((x) => setMessage(`${x.queued} file(s) queued for retry.`))}
                      >
                        Retry failed files
                      </button>
                    )}
                    {items?.length ? (
                      <table>
                        <thead><tr><th>File</th><th>Action</th><th>Status</th><th>Attempts</th><th>Error</th></tr></thead>
                        <tbody>
                          {items.map((i) => (
                            <tr key={i.id}><td>{i.path}</td><td>{i.action}</td><td><Badge value={i.status} /></td><td>{i.attempts}</td><td className="error small">{i.error}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <span className="muted">No file changes in this run.</span>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </>
  );
}
