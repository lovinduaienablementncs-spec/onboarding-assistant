import { useState } from "react";
import { api, useApi } from "../../api";
import { Badge, Loading, when } from "../../components/ui";

interface Source {
  id: string;
  name: string;
  connector: "onedrive" | "local";
  driveId: string;
  folderPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  fileTypes: string[];
  ucIdPattern: string;
  docTypeRules: Array<{ type: string; pathPattern: string }>;
  deltaCron: string;
  fullCron: string;
  enabled: boolean;
  hasDeltaLink: boolean;
  updatedAt: string;
}

interface Preview {
  scanned: number;
  matched: number;
  missingUcId: number;
  files: Array<{ path: string; ucId: string | null; docType: string }>;
}

const EMPTY = { name: "", connector: "local" as "local" | "onedrive", driveId: "", folderPath: "/", excludeGlobs: "", ucIdPattern: "UC[-_ ]?\\d{2,4}", deltaCron: "*/30 * * * *", fullCron: "0 2 * * *" };

export function Sources({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, loading, reload } = useApi<Source[]>("/admin/sources");
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [preview, setPreview] = useState<Preview>();
  const [message, setMessage] = useState<string>();

  const body = (f: typeof EMPTY) => ({
    name: f.name,
    connector: f.connector,
    driveId: f.driveId,
    folderPath: f.folderPath,
    excludeGlobs: f.excludeGlobs.split(",").map((s) => s.trim()).filter(Boolean),
    ucIdPattern: f.ucIdPattern,
    deltaCron: f.deltaCron,
    fullCron: f.fullCron,
  });

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      setMessage(done);
      await reload();
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Sources</h1>
        {isAdmin && !form && <button className="primary" onClick={() => { setForm(EMPTY); setPreview(undefined); }}>Add source</button>}
      </div>
      {message && <p className={message.startsWith("Error") ? "error" : "muted"}>{message}</p>}
      <Loading error={error} loading={loading && !data} />

      {form && (
        <div className="card stack" style={{ marginBottom: 20 }}>
          <h2 style={{ marginTop: 0 }}>New source</h2>
          <label className="stack">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="stack">
            Type
            <select value={form.connector} onChange={(e) => setForm({ ...form, connector: e.target.value as "local" | "onedrive" })}>
              <option value="local">Local folder</option>
              <option value="onedrive">OneDrive / SharePoint</option>
            </select>
          </label>
          <label className="stack">
            {form.connector === "local" ? "Folder on the server (must be under LOCAL_SOURCE_ROOTS)" : "Drive id (document library)"}
            <input value={form.driveId} onChange={(e) => setForm({ ...form, driveId: e.target.value })} placeholder={form.connector === "local" ? "C:/Users/me/OnboardingDocs" : "b!abc..."} />
          </label>
          <label className="stack">Folder inside it<input value={form.folderPath} onChange={(e) => setForm({ ...form, folderPath: e.target.value })} /></label>
          <label className="stack">Exclude patterns (comma separated)<input value={form.excludeGlobs} onChange={(e) => setForm({ ...form, excludeGlobs: e.target.value })} placeholder="Archive/**, Drafts/**" /></label>
          <label className="stack">UC id pattern (regex)<input value={form.ucIdPattern} onChange={(e) => setForm({ ...form, ucIdPattern: e.target.value })} /></label>
          <div className="row">
            <label className="stack">Delta sync (cron)<input value={form.deltaCron} onChange={(e) => setForm({ ...form, deltaCron: e.target.value })} /></label>
            <label className="stack">Full check (cron)<input value={form.fullCron} onChange={(e) => setForm({ ...form, fullCron: e.target.value })} /></label>
          </div>
          <div className="row">
            <button onClick={() => void api<Preview>("/admin/sources/preview", { method: "POST", body: body(form) }).then(setPreview).catch((e) => setMessage(`Error: ${e.message}`))}>
              Test connection &amp; preview
            </button>
            <button className="primary" disabled={!form.name || !form.driveId} onClick={() => void act(() => api("/admin/sources", { method: "POST", body: body(form) }), "Source added; the first full crawl has been queued.").then(() => setForm(null))}>
              Save
            </button>
            <button onClick={() => setForm(null)}>Cancel</button>
          </div>
          {preview && (
            <div>
              <p>
                {preview.matched} of {preview.scanned} files would be indexed{preview.missingUcId ? `, ${preview.missingUcId} without a UC id in the name` : ""}.
              </p>
              <table>
                <thead><tr><th>File</th><th>UC id</th><th>Type (from folder)</th></tr></thead>
                <tbody>
                  {preview.files.slice(0, 100).map((f) => (
                    <tr key={f.path}><td>{f.path}</td><td>{f.ucId ?? <span className="muted">none</span>}</td><td>{f.docType}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <table>
        <thead>
          <tr><th>Name</th><th>Location</th><th>Schedule</th><th>Status</th><th>Updated</th>{isAdmin && <th />}</tr>
        </thead>
        <tbody>
          {data?.map((s) => (
            <tr key={s.id}>
              <td>{s.name}<div className="muted small">{s.connector}</div></td>
              <td className="small">{s.driveId}<br />{s.folderPath}</td>
              <td className="small">delta {s.deltaCron}<br />full {s.fullCron}</td>
              <td><Badge value={s.enabled ? "ok" : "paused"} /></td>
              <td className="small">{when(s.updatedAt)}</td>
              {isAdmin && (
                <td>
                  <div className="row">
                    <button onClick={() => void act(() => api(`/admin/sources/${s.id}/sync`, { method: "POST", body: { mode: "delta" } }), "Sync queued.")}>Sync now</button>
                    <button onClick={() => void act(() => api(`/admin/sources/${s.id}/sync`, { method: "POST", body: { mode: "full" } }), "Full reindex queued.")}>Full reindex</button>
                    <button onClick={() => void act(() => api(`/admin/sources/${s.id}/${s.enabled ? "pause" : "resume"}`, { method: "POST" }), s.enabled ? "Paused." : "Resumed.")}>{s.enabled ? "Pause" : "Resume"}</button>
                    <button
                      onClick={() => {
                        if (window.confirm(`Delete source "${s.name}"? Its documents are removed from search.`)) void act(() => api(`/admin/sources/${s.id}`, { method: "DELETE" }), "Deleted.");
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
