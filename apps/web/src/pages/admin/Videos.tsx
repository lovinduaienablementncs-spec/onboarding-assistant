import { useState } from "react";
import { Link } from "react-router-dom";
import { useApi, useBlobUrl } from "../../api";
import { Badge, Loading, when } from "../../components/ui";

interface Video {
  id: string;
  question: string;
  status: string;
  ucIds: string[];
  durationSec: number | null;
  hasVoice: boolean;
  storyboard: { scenes: Array<{ screenId: string | null; element: string | null; narration: string; narrationSource: string }> } | null;
  error: string | null;
  traceId: string | null;
  createdAt: string;
}

export function Videos() {
  const { data, error, loading, reload } = useApi<Video[]>("/admin/videos?limit=100");
  const [open, setOpen] = useState<string>();

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Video guides</h1>
        <button onClick={() => void reload()}>Refresh</button>
      </div>
      <Loading error={error} loading={loading && !data} />
      <table>
        <thead>
          <tr><th>Created</th><th>Question</th><th>Use cases</th><th>Status</th><th>Length</th><th>Voice</th></tr>
        </thead>
        <tbody>
          {data?.map((v) => (
            <tr key={v.id} className="clickable" onClick={() => setOpen(open === v.id ? undefined : v.id)}>
              <td className="small">{when(v.createdAt)}</td>
              <td>{v.question}{v.error && <div className="error small">{v.error.slice(0, 200)}</div>}</td>
              <td>{v.ucIds.join(", ")}</td>
              <td><Badge value={v.status} /></td>
              <td>{v.durationSec ? `${Math.round(v.durationSec)}s` : "—"}</td>
              <td>{v.hasVoice ? "yes" : "captions"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {open && <VideoDetail video={data!.find((v) => v.id === open)!} />}
    </>
  );
}

function VideoDetail({ video: v }: { video: Video }) {
  const url = useBlobUrl(v.status === "ready" ? `/videos/${v.id}/file` : null);
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0 }}>{v.question}</h2>
      {url && <video src={url} controls style={{ width: "100%", maxWidth: 800 }} />}
      {v.traceId && <p className="small"><Link to={`/admin/sessions/${v.traceId}`}>Question trace</Link></p>}
      <h2>Storyboard</h2>
      <ol>
        {v.storyboard?.scenes.map((s, i) => (
          <li key={i} className="small" style={{ marginBottom: 6 }}>
            {s.narration}{" "}
            <span className="muted">
              ({s.screenId ? `screen${s.element ? `, highlight “${s.element}”` : ""}` : "text card"} · narration {s.narrationSource})
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
