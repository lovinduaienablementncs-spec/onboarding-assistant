import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useApi } from "./api";
import { isDevAuth, signOut } from "./auth";
import { Chat } from "./pages/Chat";
import { AdminHome } from "./pages/admin/AdminHome";
import { Audit } from "./pages/admin/Audit";
import { CrawlRuns } from "./pages/admin/CrawlRuns";
import { Documents } from "./pages/admin/Documents";
import { Insights } from "./pages/admin/Insights";
import { Playground } from "./pages/admin/Playground";
import { Screens } from "./pages/admin/Screens";
import { Sessions } from "./pages/admin/Sessions";
import { Settings } from "./pages/admin/Settings";
import { Sources } from "./pages/admin/Sources";
import { Usage } from "./pages/admin/Usage";
import { Videos } from "./pages/admin/Videos";

export interface Me {
  id: string;
  name?: string;
  roles: string[];
}

const ADMIN_PAGES: Array<{ path: string; label: string; adminOnly?: boolean }> = [
  { path: "/admin", label: "Overview" },
  { path: "/admin/sources", label: "Sources" },
  { path: "/admin/crawl", label: "Crawl jobs" },
  { path: "/admin/documents", label: "Documents" },
  { path: "/admin/screens", label: "Screens" },
  { path: "/admin/sessions", label: "Sessions" },
  { path: "/admin/usage", label: "Usage" },
  { path: "/admin/videos", label: "Videos" },
  { path: "/admin/insights", label: "Insights" },
  { path: "/admin/playground", label: "Playground", adminOnly: true },
  { path: "/admin/settings", label: "Settings", adminOnly: true },
  { path: "/admin/audit", label: "Audit", adminOnly: true },
];

export function App() {
  const { data: me, error } = useApi<Me>("/me");
  if (error) return <p className="error" style={{ padding: 24 }}>Sign-in failed: {error}</p>;
  if (!me) return <p className="muted" style={{ padding: 24 }}>Loading…</p>;

  const isAdmin = me.roles.includes("Assistant.Admin");
  const isReviewer = isAdmin || me.roles.includes("Assistant.ContentReviewer");
  const pages = ADMIN_PAGES.filter((p) => !p.adminOnly || isAdmin);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Onboarding Assistant</span>
        <nav>
          <NavLink to="/" end>Chat</NavLink>
          {isReviewer && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <span className="spacer" />
        <span className="muted small">
          {me.name ?? me.id} {isDevAuth() && <span className="badge warning">dev sign-in</span>}
        </span>
        {!isDevAuth() && <button onClick={() => void signOut()}>Sign out</button>}
      </header>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/c/:conversationId" element={<Chat />} />
        {isReviewer && (
          <Route
            path="/admin/*"
            element={
              <div className="admin">
                <div className="inner">
                  <nav className="row" style={{ marginBottom: 20 }}>
                    {pages.map((p) => (
                      <NavLink key={p.path} to={p.path} end className={({ isActive }) => (isActive ? "badge" : "muted small")} style={{ textDecoration: "none", padding: "4px 8px" }}>
                        {p.label}
                      </NavLink>
                    ))}
                  </nav>
                  <Routes>
                    <Route index element={<AdminHome />} />
                    <Route path="sources" element={<Sources isAdmin={isAdmin} />} />
                    <Route path="crawl" element={<CrawlRuns isAdmin={isAdmin} />} />
                    <Route path="documents" element={<Documents />} />
                    <Route path="screens" element={<Screens />} />
                    <Route path="sessions" element={<Sessions />} />
                    <Route path="sessions/:traceId" element={<Sessions />} />
                    <Route path="usage" element={<Usage />} />
                    <Route path="videos" element={<Videos />} />
                    <Route path="insights" element={<Insights />} />
                    {isAdmin && <Route path="playground" element={<Playground />} />}
                    {isAdmin && <Route path="settings" element={<Settings />} />}
                    {isAdmin && <Route path="audit" element={<Audit />} />}
                  </Routes>
                </div>
              </div>
            }
          />
        )}
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </div>
  );
}
