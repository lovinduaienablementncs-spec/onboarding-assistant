import { useApi } from "../../api";
import { Json, Loading, when } from "../../components/ui";

interface Entry {
  id: string;
  actorName: string | null;
  actorId: string;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  createdAt: string;
}

export function Audit() {
  const { data, error, loading } = useApi<Entry[]>("/admin/audit-log?limit=200");
  return (
    <>
      <h1>Audit log</h1>
      <Loading error={error} loading={loading && !data} />
      <table>
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>What</th><th>Change</th></tr></thead>
        <tbody>
          {data?.map((e) => (
            <tr key={e.id}>
              <td className="small">{when(e.createdAt)}</td>
              <td className="small">{e.actorName ?? e.actorId}<div className="muted">{e.ip}</div></td>
              <td>{e.action}</td>
              <td className="small">{e.entity} {e.entityId}</td>
              <td>
                {(e.before !== null || e.after !== null) && (
                  <details>
                    <summary className="small muted">before / after</summary>
                    <Json value={{ before: e.before, after: e.after }} />
                  </details>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
