import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, useApi } from "../../api";
import { Badge, Loading, when } from "../../components/ui";

interface DocRow {
  id: string;
  name: string;
  path: string;
  webUrl: string;
  ucId: string | null;
  docType: string;
  version: number;
  status: string;
  lastIndexedAt: string | null;
  lastError: string | null;
  chunkCount: number;
  screenCount: number;
}

interface DocDetail extends DocRow {
  ucIdOverride: string | null;
  docTypeOverride: string | null;
  parserVersion: number;
  chunks: Array<{ id: string; section: string; headingPath: string[]; ordinal: number; text: string }>;
  screens: Array<{ id: string; caption: string | null; verified: boolean }>;
  links: Array<{ ucId: string; ucsDocumentId: string | null; uisDocumentId: string | null; origin: string }>;
}

export function Documents() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const status = params.get("status") ?? "";
  const query = new URLSearchParams({ limit: "200", ...(params.get("q") ? { q: params.get("q")! } : {}), ...(status ? { status } : {}) });
  const { data, error, loading, reload } = useApi<{ total: number; items: DocRow[] }>(`/admin/documents?${query}`);
  const [open, setOpen] = useState<string>();

  return (
    <>
      <h1>Documents</h1>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, path or UC id" />
        <select value={status} onChange={(e) => setParams({ ...(q ? { q } : {}), ...(e.target.value ? { status: e.target.value } : {}) })}>
          <option value="">All live</option>
          <option value="indexed">Indexed</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
          <option value="deleted">Deleted</option>
        </select>
        <button>Search</button>
        <span className="muted small">{data?.total ?? 0} documents</span>
      </form>
      <Loading error={error} loading={loading && !data} />
      <table>
        <thead>
          <tr><th>UC</th><th>Type</th><th>Document</th><th>Version</th><th>Sections</th><th>Screens</th><th>Status</th><th>Indexed</th></tr>
        </thead>
        <tbody>
          {data?.items.map((d) => (
            <tr key={d.id} className="clickable" onClick={() => setOpen(d.id)}>
              <td>{d.ucId ?? <span className="muted">—</span>}</td>
              <td>{d.docType}</td>
              <td>{d.name}<div className="muted small">{d.path}</div></td>
              <td>{d.version}</td>
              <td>{d.chunkCount}</td>
              <td>{d.screenCount}</td>
              <td><Badge value={d.status} />{d.lastError && <div className="error small">{d.lastError.slice(0, 120)}</div>}</td>
              <td className="small">{when(d.lastIndexedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <DocumentDetail id={open} onClose={() => { setOpen(undefined); void reload(); }} />}
    </>
  );
}

function DocumentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: d, reload } = useApi<DocDetail>(`/admin/documents/${id}`);
  const [ucId, setUcId] = useState("");
  const [docType, setDocType] = useState("");
  const [message, setMessage] = useState<string>();
  if (!d) return null;

  async function save() {
    try {
      await api(`/admin/documents/${id}`, {
        method: "PATCH",
        body: { ...(ucId ? { ucIdOverride: ucId.toUpperCase() } : {}), ...(docType ? { docTypeOverride: docType } : {}) },
      });
      setMessage("Saved; the document is being re-indexed with the correction.");
      await reload();
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>{d.name}</h2>
        <button onClick={onClose}>Close</button>
      </div>
      <p className="small">
        <a href={d.webUrl} target="_blank" rel="noreferrer">{d.path}</a> · version {d.version} · parser v{d.parserVersion}
      </p>
      <div className="row">
        <span>UC id: <b>{d.ucId ?? "none"}</b>{d.ucIdOverride && " (corrected)"}</span>
        <span>Type: <b>{d.docType}</b>{d.docTypeOverride && " (corrected)"}</span>
        <button onClick={() => void api(`/admin/documents/${id}/reindex`, { method: "POST" }).then(() => setMessage("Re-index queued."))}>Re-index</button>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input placeholder="Correct UC id, e.g. UC-045" value={ucId} onChange={(e) => setUcId(e.target.value)} />
        <select value={docType} onChange={(e) => setDocType(e.target.value)}>
          <option value="">Keep type</option>
          <option value="UCS">UCS</option>
          <option value="UIS">UIS</option>
          <option value="OTHER">Other</option>
        </select>
        <button disabled={!ucId && !docType} onClick={() => void save()}>Save correction</button>
      </div>
      {message && <p className="muted">{message}</p>}
      {d.links.length > 0 && (
        <p className="small muted">
          Linked: {d.links.map((l) => `${l.ucId} ${l.ucsDocumentId ? "UCS" : ""}${l.ucsDocumentId && l.uisDocumentId ? " + " : ""}${l.uisDocumentId ? "UIS" : ""}`).join(", ")}
        </p>
      )}
      <h2>Sections ({d.chunks.length})</h2>
      {d.chunks.map((c) => (
        <details key={c.id} style={{ marginBottom: 6 }}>
          <summary>
            <b>{c.section}</b> <span className="muted small">{c.headingPath.join(" > ")} · {c.text.length} chars</span>
          </summary>
          <pre style={{ padding: "8px 0" }}>{c.text}</pre>
        </details>
      ))}
      <h2>Screenshots ({d.screens.length})</h2>
      {d.screens.map((s) => (
        <div key={s.id} className="small">{s.caption} {s.verified && <Badge value="ok" />}</div>
      ))}
    </div>
  );
}
