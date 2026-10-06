import { useState } from "react";
import { api, useApi, useBlobUrl } from "../../api";
import { Loading } from "../../components/ui";

interface UiElement {
  label: string;
  type: string;
  box: [number, number, number, number];
}

interface Screen {
  id: string;
  ucId: string | null;
  caption: string | null;
  documentName: string;
  verified: boolean;
  describeError: string | null;
  description: { screenName: string; purpose: string; navigationPath: string; uiElements: UiElement[] } | null;
}

export function Screens() {
  const [status, setStatus] = useState("all");
  const { data, error, loading, reload } = useApi<Screen[]>(`/admin/screens?status=${status}&limit=100`);

  return (
    <>
      <h1>Screens</h1>
      <p className="muted">
        Screenshots from UI specifications. Claude lists the visible elements with boxes; videos highlight these boxes. Correct a box and mark the screen verified when it is right.
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        {["all", "pending", "described", "verified", "failed"].map((s) => (
          <button key={s} className={s === status ? "primary" : ""} onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>
      <Loading error={error} loading={loading && !data} />
      {!data?.length && !loading && <p className="muted">No screens in this view.</p>}
      <div className="stack" style={{ gap: 20 }}>
        {data?.map((s) => <ScreenCard key={s.id} screen={s} onChange={() => void reload()} />)}
      </div>
    </>
  );
}

function ScreenCard({ screen: s, onChange }: { screen: Screen; onChange: () => void }) {
  const url = useBlobUrl(`/admin/screens/${s.id}/image`);
  const [elements, setElements] = useState<UiElement[]>(s.description?.uiElements ?? []);
  const [selected, setSelected] = useState<number>();
  const dirty = JSON.stringify(elements) !== JSON.stringify(s.description?.uiElements ?? []);

  async function save(verified: boolean) {
    await api(`/admin/screens/${s.id}`, { method: "PATCH", body: { verified, ...(s.description ? { description: { ...s.description, uiElements: elements } } : {}) } });
    onChange();
  }

  const setBox = (i: number, k: number, v: number) =>
    setElements((els) => els.map((e, j) => (j === i ? { ...e, box: e.box.map((b, n) => (n === k ? v : b)) as UiElement["box"] } : e)));

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <b>{s.description?.screenName ?? s.caption ?? "Screenshot"}</b> <span className="muted small">{s.ucId} · {s.documentName}</span>
        </div>
        <div className="row">
          {s.verified ? <span className="badge ok">verified</span> : s.description ? <span className="badge pending">not verified</span> : null}
          {s.describeError && <span className="badge failed">failed</span>}
          {!s.description && !s.describeError && <span className="badge queued">waiting for description</span>}
        </div>
      </div>
      {s.describeError && <p className="error small">{s.describeError}</p>}
      <div className="row" style={{ alignItems: "flex-start", marginTop: 10 }}>
        <div className="screen-img" style={{ maxWidth: 640 }}>
          {url && <img src={url} alt={s.caption ?? ""} />}
          {elements.map((e, i) => (
            <div
              key={i}
              className="box"
              onClick={() => setSelected(i)}
              style={{ left: `${e.box[0] * 100}%`, top: `${e.box[1] * 100}%`, width: `${e.box[2] * 100}%`, height: `${e.box[3] * 100}%`, borderColor: i === selected ? "#0369a1" : undefined }}
            >
              <span>{e.label}</span>
            </div>
          ))}
        </div>
        <div className="stack" style={{ flex: 1, minWidth: 260 }}>
          {s.description && <div className="small">{s.description.purpose}</div>}
          {elements.map((e, i) => (
            <div key={i} className="small" style={{ background: i === selected ? "var(--accent-soft)" : undefined, padding: 4, borderRadius: 4 }} onClick={() => setSelected(i)}>
              <b>{e.label}</b> <span className="muted">{e.type}</span>
              {i === selected && (
                <div className="row" style={{ marginTop: 4 }}>
                  {["x", "y", "w", "h"].map((k, n) => (
                    <label key={k}>
                      {k}{" "}
                      <input type="number" min={0} max={1} step={0.01} style={{ width: 70 }} value={e.box[n]} onChange={(ev) => setBox(i, n, Number(ev.target.value))} />
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            {s.description && <button className="primary" onClick={() => void save(true)}>{dirty ? "Save and verify" : "Mark verified"}</button>}
            {dirty && <button onClick={() => void save(s.verified)}>Save boxes</button>}
            <button onClick={() => void api(`/admin/screens/${s.id}/redescribe`, { method: "POST" }).then(onChange)}>Describe again</button>
          </div>
        </div>
      </div>
    </div>
  );
}
