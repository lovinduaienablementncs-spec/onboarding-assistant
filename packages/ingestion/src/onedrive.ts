import { ClientSecretCredential, type TokenCredential } from "@azure/identity";
import { env } from "@oa/shared";
import type { ChangePage, SourceConnector, SourceItem } from "./connector.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES = 5;

interface DriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  cTag?: string;
  folder?: unknown;
  file?: unknown;
  deleted?: unknown;
  root?: unknown;
  parentReference?: { path?: string };
}

interface PermissionGrant {
  grantedToV2?: Record<string, { id?: string } | undefined>;
  grantedToIdentitiesV2?: Array<Record<string, { id?: string } | undefined>>;
}

/** App-only Microsoft Graph client that honours 429 Retry-After and retries 5xx. */
export class GraphClient {
  private credential: TokenCredential;

  constructor(credential?: TokenCredential, private fetchImpl: typeof fetch = fetch) {
    this.credential = credential ?? new ClientSecretCredential(env.tenantId, env.clientId, env.clientSecret);
  }

  async get(pathOrUrl: string, attempt = 1): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const token = await this.credential.getToken("https://graph.microsoft.com/.default");
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token?.token}` } });
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get("Retry-After"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
      return this.get(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`Graph ${res.status} for ${url}: ${await res.text()}`);
    return res;
  }

  async json<T>(pathOrUrl: string): Promise<T> {
    return (await this.get(pathOrUrl)).json() as Promise<T>;
  }
}

/**
 * OneDrive / SharePoint document library connector.
 * Delta is read from the drive root (folder-scoped delta is not supported on
 * SharePoint); callers filter items to the configured folder with `inScope`.
 */
export class OneDriveConnector implements SourceConnector {
  constructor(private driveId: string, private graph = new GraphClient()) {}

  async *listChanges(cursor?: string | null): AsyncIterable<ChangePage> {
    let url: string | undefined =
      cursor ?? `/drives/${this.driveId}/root/delta?$select=id,name,webUrl,cTag,folder,file,deleted,root,parentReference`;
    while (url) {
      const body: { value: DriveItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } = await this.graph.json(url);
      url = body["@odata.nextLink"];
      yield { items: body.value.filter((i) => !i.root).map(toSourceItem), nextCursor: url ? undefined : body["@odata.deltaLink"] };
    }
  }

  async download(externalId: string): Promise<Buffer> {
    const res = await this.graph.get(`/drives/${this.driveId}/items/${externalId}/content`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getAcl(externalId: string): Promise<string[]> {
    const { value } = await this.graph.json<{ value: PermissionGrant[] }>(`/drives/${this.driveId}/items/${externalId}/permissions`);
    const ids = new Set<string>();
    for (const p of value) {
      for (const grant of [p.grantedToV2, ...(p.grantedToIdentitiesV2 ?? [])]) {
        for (const principal of Object.values(grant ?? {})) if (principal?.id) ids.add(principal.id);
      }
    }
    return [...ids];
  }
}

export interface DirectoryEntry {
  id: string;
  name: string;
  webUrl?: string;
}

/** Lets the admin UI browse SharePoint sites, their document libraries and folders. */
export class GraphDirectory {
  constructor(private graph = new GraphClient()) {}

  async searchSites(query: string): Promise<DirectoryEntry[]> {
    const { value } = await this.graph.json<{ value: Array<{ id: string; displayName: string; webUrl: string }> }>(
      `/sites?search=${encodeURIComponent(query || "*")}`,
    );
    return value.map((s) => ({ id: s.id, name: s.displayName, webUrl: s.webUrl }));
  }

  async listDrives(siteId: string): Promise<DirectoryEntry[]> {
    const { value } = await this.graph.json<{ value: Array<{ id: string; name: string; webUrl: string }> }>(
      `/sites/${encodeURIComponent(siteId)}/drives`,
    );
    return value.map((d) => ({ id: d.id, name: d.name, webUrl: d.webUrl }));
  }

  async listFolders(driveId: string, folderPath = "/"): Promise<DirectoryEntry[]> {
    const trimmed = folderPath.replace(/^\/+|\/+$/g, "");
    const base = trimmed ? `/drives/${driveId}/root:/${encodeURI(trimmed)}:/children` : `/drives/${driveId}/root/children`;
    const { value } = await this.graph.json<{ value: DriveItem[] }>(`${base}?$select=id,name,webUrl,folder&$top=200`);
    return value.filter((i) => i.folder).map((i) => ({ id: i.id, name: i.name ?? "", webUrl: i.webUrl }));
  }
}

export function toSourceItem(i: DriveItem): SourceItem {
  // parentReference.path looks like "/drives/{id}/root:/Specs/UCS"
  const parent = decodeURIComponent(i.parentReference?.path?.split("root:")[1] ?? "");
  return {
    externalId: i.id,
    name: i.name ?? "",
    path: `${parent}/${i.name ?? ""}`,
    webUrl: i.webUrl ?? "",
    isFolder: Boolean(i.folder),
    deleted: Boolean(i.deleted),
    cTag: i.cTag,
  };
}
