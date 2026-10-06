import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChangePage, SourceConnector, SourceItem } from "./connector.js";

/** Cursor for a local folder: the cTag of every file seen at the end of the last run. */
type Snapshot = Record<string, string>;

const PAGE_SIZE = 200;

/**
 * Reads documents from a folder on disk. Used for local demos and as a
 * stand-in until the Microsoft 365 tenant is available. Changes are found by
 * comparing size and modification time with a snapshot stored as the cursor.
 * A rename shows up as a delete plus an add.
 */
export class LocalFolderConnector implements SourceConnector {
  private root: string;

  constructor(rootDir: string, allowedRoots = parseAllowedRoots()) {
    this.root = resolve(rootDir);
    // The admin UI can point a source at any path, so only allow configured roots.
    if (!allowedRoots.some((r) => this.root === r || this.root.startsWith(r + sep))) {
      throw new Error(`Folder ${this.root} is outside LOCAL_SOURCE_ROOTS`);
    }
  }

  async *listChanges(cursor?: string | null): AsyncIterable<ChangePage> {
    const previous: Snapshot = cursor ? JSON.parse(cursor) : {};
    const current: Snapshot = {};
    const items: SourceItem[] = [];

    for (const file of await this.walk(this.root)) {
      const s = await stat(file);
      const id = this.idFor(file);
      const cTag = `${s.size}-${Math.trunc(s.mtimeMs)}`;
      current[id] = cTag;
      if (!cursor || previous[id] !== cTag) items.push(this.toItem(id, cTag, false));
    }
    for (const id of Object.keys(previous)) {
      if (!(id in current)) items.push(this.toItem(id, undefined, true));
    }

    for (let i = 0; i < items.length || i === 0; i += PAGE_SIZE) {
      const last = i + PAGE_SIZE >= items.length;
      yield { items: items.slice(i, i + PAGE_SIZE), nextCursor: last ? JSON.stringify(current) : undefined };
      if (last) break;
    }
  }

  async download(externalId: string): Promise<Buffer> {
    return readFile(this.fileFor(externalId));
  }

  async getAcl(): Promise<string[]> {
    return [];
  }

  /** Ids are the path relative to the root with forward slashes, e.g. "UCS/UC-045.docx". */
  private idFor(file: string) {
    return relative(this.root, file).split(sep).join("/");
  }

  private fileFor(id: string) {
    const file = resolve(this.root, id);
    if (!file.startsWith(this.root + sep)) throw new Error(`Invalid id ${id}`);
    return file;
  }

  private toItem(id: string, cTag: string | undefined, deleted: boolean): SourceItem {
    return {
      externalId: id,
      name: id.split("/").pop()!,
      path: `/${id}`,
      webUrl: pathToFileURL(join(this.root, id)).href,
      isFolder: false,
      deleted,
      cTag,
    };
  }

  private async walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.walk(full)));
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }
}

function parseAllowedRoots(): string[] {
  return (process.env.LOCAL_SOURCE_ROOTS ?? "")
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => resolve(r));
}
