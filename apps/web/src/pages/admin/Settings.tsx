import { useEffect, useState } from "react";
import { api, useApi } from "../../api";
import { Loading, when } from "../../components/ui";

interface AssistantSettings {
  grounding: { minRelevance: number; minChunks: number; topK: number; maxRemovedRatio: number; refusalMessage: string; narrationMode: "extractive" | "generative" };
  models: { router: string; answer: string; verifier: string; vision: string; storyboard: string; answerEffort: "low" | "medium" | "high" };
  video: { voice: string; maxScenes: number; maxSeconds: number };
  budget: { dailyUsd: number; monthlyUsd: number; perUserDailyUsd: number };
}

interface Price {
  model: string;
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

export function Settings() {
  const { data, error, reload } = useApi<AssistantSettings>("/admin/settings");
  const { data: history, reload: reloadHistory } = useApi<Array<{ version: number; active: boolean; changedBy: string; createdAt: string }>>("/admin/settings/history");
  const [s, setS] = useState<AssistantSettings>();
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    setS(data);
  }, [data]);
  if (!s) return <Loading error={error} loading />;

  const set = <K extends keyof AssistantSettings>(group: K, key: keyof AssistantSettings[K], value: unknown) =>
    setS({ ...s, [group]: { ...s[group], [key]: value } });
  const n = (v: string) => (v === "" ? 0 : Number(v));

  async function save() {
    try {
      const r = await api<{ version: number }>("/admin/settings", { method: "PUT", body: s });
      setMessage(`Saved as version ${r.version}.`);
      await Promise.all([reload(), reloadHistory()]);
    } catch (e) {
      setMessage(`Error: ${(e as Error).message}`);
    }
  }

  return (
    <>
      <h1>Settings</h1>
      <div className="card stack">
        <h2 style={{ marginTop: 0 }}>Grounding</h2>
        <label className="row">Minimum relevance (0-1) to answer <input type="number" step={0.05} min={0} max={1} value={s.grounding.minRelevance} onChange={(e) => set("grounding", "minRelevance", n(e.target.value))} /></label>
        <label className="row">Minimum relevant sections <input type="number" min={1} value={s.grounding.minChunks} onChange={(e) => set("grounding", "minChunks", n(e.target.value))} /></label>
        <label className="row">Sections given to the answer model <input type="number" min={1} max={20} value={s.grounding.topK} onChange={(e) => set("grounding", "topK", n(e.target.value))} /></label>
        <label className="row">Refuse if more than this share of claims is removed <input type="number" step={0.05} min={0} max={1} value={s.grounding.maxRemovedRatio} onChange={(e) => set("grounding", "maxRemovedRatio", n(e.target.value))} /></label>
        <label className="stack">Refusal message<textarea rows={2} value={s.grounding.refusalMessage} onChange={(e) => set("grounding", "refusalMessage", e.target.value)} /></label>
        <label className="row">
          Video narration
          <select value={s.grounding.narrationMode} onChange={(e) => set("grounding", "narrationMode", e.target.value)}>
            <option value="generative">Rephrased, then verified</option>
            <option value="extractive">Exact cited sentences (strictest)</option>
          </select>
        </label>

        <h2>Models</h2>
        {(["router", "answer", "verifier", "vision", "storyboard"] as const).map((k) => (
          <label key={k} className="row">
            {k}
            <select value={s.models[k]} onChange={(e) => set("models", k, e.target.value)}>
              {[...new Set([s.models[k], ...MODELS])].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
        ))}
        <label className="row">
          Answer effort
          <select value={s.models.answerEffort} onChange={(e) => set("models", "answerEffort", e.target.value)}>
            {["low", "medium", "high"].map((x) => <option key={x}>{x}</option>)}
          </select>
        </label>

        <h2>Video</h2>
        <label className="row">Azure voice <input value={s.video.voice} onChange={(e) => set("video", "voice", e.target.value)} /></label>
        <label className="row">Maximum scenes <input type="number" min={2} max={15} value={s.video.maxScenes} onChange={(e) => set("video", "maxScenes", n(e.target.value))} /></label>

        <h2>Budget (USD)</h2>
        <label className="row">Daily <input type="number" min={0} value={s.budget.dailyUsd} onChange={(e) => set("budget", "dailyUsd", n(e.target.value))} /></label>
        <label className="row">Monthly <input type="number" min={0} value={s.budget.monthlyUsd} onChange={(e) => set("budget", "monthlyUsd", n(e.target.value))} /></label>
        <label className="row">Per user per day <input type="number" min={0} value={s.budget.perUserDailyUsd} onChange={(e) => set("budget", "perUserDailyUsd", n(e.target.value))} /></label>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void save()}>Save as new version</button>
          {message && <span className={message.startsWith("Error") ? "error" : "muted"}>{message}</span>}
        </div>
      </div>

      <h2>Version history</h2>
      <table>
        <thead><tr><th>Version</th><th>Saved</th><th>By</th><th /></tr></thead>
        <tbody>
          {history?.map((h) => (
            <tr key={h.version}>
              <td>v{h.version} {h.active && <span className="badge ok">active</span>}</td>
              <td className="small">{when(h.createdAt)}</td>
              <td className="small">{h.changedBy}</td>
              <td>{!h.active && <button onClick={() => void api(`/admin/settings/${h.version}/activate`, { method: "POST" }).then(() => Promise.all([reload(), reloadHistory()]))}>Roll back to this</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Prices />
      <Secrets />
    </>
  );
}

function Prices() {
  const { data, reload } = useApi<Price[]>("/admin/prices");
  const [edit, setEdit] = useState<Price>();
  return (
    <>
      <h2>Prices (USD per million tokens; TTS per million characters)</h2>
      <table>
        <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th /></tr></thead>
        <tbody>
          {data?.map((p) =>
            edit?.model === p.model ? (
              <tr key={p.model}>
                <td>{p.model}</td>
                {(["inputPerM", "outputPerM", "cacheReadPerM", "cacheWritePerM"] as const).map((k) => (
                  <td key={k}><input type="number" step={0.01} style={{ width: 80 }} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })} /></td>
                ))}
                <td>
                  <button onClick={() => void api(`/admin/prices/${p.model}`, { method: "PUT", body: { inputPerM: edit.inputPerM, outputPerM: edit.outputPerM, cacheReadPerM: edit.cacheReadPerM, cacheWritePerM: edit.cacheWritePerM } }).then(() => { setEdit(undefined); void reload(); })}>Save</button>
                </td>
              </tr>
            ) : (
              <tr key={p.model}>
                <td>{p.model}</td><td>{p.inputPerM}</td><td>{p.outputPerM}</td><td>{p.cacheReadPerM}</td><td>{p.cacheWritePerM}</td>
                <td><button onClick={() => setEdit(p)}>Edit</button></td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </>
  );
}

function Secrets() {
  const { data } = useApi<Array<{ name: string; set: boolean }>>("/admin/secrets/status");
  return (
    <>
      <h2>Secrets</h2>
      <p className="muted small">Secrets are read from Key Vault or the server environment and are never shown here.</p>
      <table>
        <tbody>
          {data?.map((s) => (
            <tr key={s.name}><td>{s.name}</td><td>{s.set ? <span className="badge ok">set</span> : <span className="badge failed">missing</span>}</td></tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
