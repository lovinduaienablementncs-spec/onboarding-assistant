import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { useNavigate, useParams } from "react-router-dom";
import { api, streamEvents, useApi, useBlobUrl } from "../api";

interface Source {
  n: number;
  ucId: string | null;
  docType: string;
  section: string;
  docName: string;
  webUrl: string;
}

interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  outcome?: "answered" | "partial" | "refused" | "error";
  sources?: Source[];
  intent?: string;
  videoJobId?: string;
  canMakeVideo?: boolean;
  rating?: number;
}

const STATUS: Record<string, string> = {
  understanding: "Understanding your question…",
  searching: "Searching the documentation…",
  writing: "Writing the answer…",
  checking: "Checking every sentence against the documents…",
};

const EXAMPLES = [
  "How can I monitor my submission record counts and reprocess failed ones?",
  "How do I filter tax notices by year?",
  "What happens when no notices match the filter?",
];

export function Chat() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { data: conversations, reload: reloadList } = useApi<Array<{ id: string; title: string }>>("/conversations");
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<string>();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const justCreated = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      return;
    }
    if (justCreated.current === conversationId) return; // already showing the streamed messages
    api<{ messages: Message[] }>(`/conversations/${conversationId}`)
      .then((c) => setMessages(c.messages))
      .catch(() => navigate("/"));
  }, [conversationId, navigate]);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages, status]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setInput("");
    setMessages((m) => [...m, { role: "user", content: text }]);
    setStatus(STATUS.understanding);
    try {
      await streamEvents("/chat", { message: text, conversationId }, (type, data) => {
        const d = data as Record<string, unknown>;
        if (type === "status") setStatus(STATUS[d.step as string]);
        if (type === "answer") {
          setStatus(undefined);
          setMessages((m) => [
            ...m,
            { id: d.messageId as string, role: "assistant", content: d.markdown as string, outcome: d.outcome as Message["outcome"], sources: d.sources as Source[], intent: d.intent as string, canMakeVideo: d.outcome !== "refused" },
          ]);
          if (!conversationId) {
            justCreated.current = d.conversationId as string;
            navigate(`/c/${d.conversationId}`, { replace: true });
          }
          void reloadList();
        }
        if (type === "video") {
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            if (last?.role === "assistant") copy[copy.length - 1] = { ...last, videoJobId: d.jobId as string };
            return copy;
          });
        }
        if (type === "error") setMessages((m) => [...m, { role: "assistant", content: d.message as string, outcome: "error" }]);
      });
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: `Could not reach the assistant: ${(e as Error).message}`, outcome: "error" }]);
    } finally {
      setStatus(undefined);
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <div className="chat">
      <aside>
        <button className="primary" style={{ width: "100%", marginBottom: 12 }} onClick={() => navigate("/")}>
          New question
        </button>
        {conversations?.map((c) => (
          <button key={c.id} className={`conv ${c.id === conversationId ? "active" : ""}`} onClick={() => navigate(`/c/${c.id}`)} title={c.title}>
            {c.title}
          </button>
        ))}
      </aside>
      <section className="thread">
        <div className="messages">
          <div className="inner">
            {!messages.length && (
              <div className="empty">
                <h1>Ask about the system</h1>
                <p className="muted">
                  Answers come only from the use case and UI specifications. How-to questions about screens also get a short video guide.
                </p>
                <div className="examples">
                  {EXAMPLES.map((q) => (
                    <button key={q} onClick={() => void send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (m.role === "user" ? <div key={i} className="msg user">{m.content}</div> : <AssistantMessage key={m.id ?? i} message={m} onChange={(next) => setMessages((all) => all.map((x) => (x === m ? next : x)))} />))}
            {status && <div className="status">{status}</div>}
            <div ref={bottom} />
          </div>
        </div>
        <div className="composer">
          <form onSubmit={onSubmit}>
            <textarea
              value={input}
              placeholder="Ask how to do something, or how a part of the system works…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) onSubmit(e);
              }}
            />
            <button className="primary" disabled={busy || !input.trim()}>Send</button>
          </form>
        </div>
      </section>
    </div>
  );
}

function AssistantMessage({ message: m, onChange }: { message: Message; onChange: (m: Message) => void }) {
  const [requesting, setRequesting] = useState(false);
  // Citation markers "[n]" become links to the source list, rendered as superscripts.
  const content = m.content.replace(/ ?\[(\d+)\]/g, (_, n) => `[${n}](#src-${n})`);

  async function rate(rating: 1 | -1) {
    if (!m.id) return;
    let comment: string | undefined;
    if (rating === -1) comment = window.prompt("What was wrong with this answer? (optional)") ?? undefined;
    await api(`/messages/${m.id}/feedback`, { method: "POST", body: { rating, comment } });
    onChange({ ...m, rating });
  }

  async function makeVideo() {
    if (!m.id) return;
    setRequesting(true);
    try {
      const { jobId } = await api<{ jobId: string }>(`/messages/${m.id}/video`, { method: "POST" });
      onChange({ ...m, videoJobId: jobId });
    } finally {
      setRequesting(false);
    }
  }

  return (
    <div className="msg assistant">
      {m.outcome && m.outcome !== "answered" && (
        <div style={{ marginBottom: 6 }}>
          <span className={`badge ${m.outcome}`}>{m.outcome === "partial" ? "Partly covered by the documentation" : m.outcome === "refused" ? "Not in the documentation" : "Error"}</span>
        </div>
      )}
      <ReactMarkdown
        components={{
          a: ({ href, children }) =>
            href?.startsWith("#src-") ? (
              <sup className="cite">[{children}]</sup>
            ) : (
              <a href={href} target="_blank" rel="noreferrer">{children}</a>
            ),
        }}
      >
        {content}
      </ReactMarkdown>
      {m.videoJobId && <VideoPanel jobId={m.videoJobId} />}
      {!!m.sources?.length && (
        <div className="sources">
          <div className="muted">Sources</div>
          {m.sources.map((s) => (
            <div key={s.n} id={`src-${s.n}`}>
              [{s.n}]{" "}
              <a href={s.webUrl} target="_blank" rel="noreferrer">
                {[s.ucId, s.docType, s.section].filter(Boolean).join(" · ")}
              </a>{" "}
              <span className="muted">({s.docName})</span>
            </div>
          ))}
        </div>
      )}
      {m.id && m.outcome !== "error" && (
        <div className="row small" style={{ marginTop: 8 }}>
          <button onClick={() => void rate(1)} disabled={m.rating === 1} title="Helpful">👍</button>
          <button onClick={() => void rate(-1)} disabled={m.rating === -1} title="Not helpful">👎</button>
          {!m.videoJobId && m.canMakeVideo && m.intent !== "ui_howto" && (
            <button onClick={() => void makeVideo()} disabled={requesting}>Generate a video guide</button>
          )}
        </div>
      )}
    </div>
  );
}

interface VideoJob {
  status: string;
  durationSec: number | null;
  hasVoice: boolean;
  error: string | null;
}

function VideoPanel({ jobId }: { jobId: string }) {
  const { data: job, reload } = useApi<VideoJob>(`/videos/${jobId}`);
  const ready = job?.status === "ready";
  const url = useBlobUrl(ready ? `/videos/${jobId}/file` : null);

  useEffect(() => {
    if (!job || ready || job.status === "failed" || job.status === "stale") return;
    const t = setTimeout(() => void reload(), 2500);
    return () => clearTimeout(t);
  }, [job, ready, reload]);

  if (!job) return null;
  if (job.status === "failed") return <div className="video muted small">{job.error}</div>;
  if (!ready || !url) {
    return (
      <div className="video status">
        Making a video guide… <span className={`badge ${job.status}`}>{job.status}</span>
      </div>
    );
  }
  return (
    <div className="video">
      <video src={url} controls preload="metadata" />
      {!job.hasVoice && <div className="muted small">No voice-over is configured, so the guide uses on-screen captions.</div>}
    </div>
  );
}
