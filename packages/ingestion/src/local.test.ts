import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SourceItem } from "./connector.js";
import { LocalFolderConnector } from "./local.js";

let root: string;
let docs: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oa-local-"));
  docs = join(root, "specs");
  await mkdir(join(docs, "UCS"), { recursive: true });
  await writeFile(join(docs, "UCS", "UC-045 Monitor.docx"), "v1");
  await writeFile(join(docs, "UCS", "UC-046 Address.docx"), "v1");
});

afterEach(() => rm(root, { recursive: true, force: true }));

async function collect(c: LocalFolderConnector, cursor?: string | null) {
  const items: SourceItem[] = [];
  let next: string | undefined;
  for await (const page of c.listChanges(cursor)) {
    items.push(...page.items);
    next = page.nextCursor ?? next;
  }
  return { items, cursor: next! };
}

describe("LocalFolderConnector", () => {
  it("lists every file first, then only what changed", async () => {
    const c = new LocalFolderConnector(docs, [root]);
    const first = await collect(c, null);
    expect(first.items.map((i) => i.path).sort()).toEqual(["/UCS/UC-045 Monitor.docx", "/UCS/UC-046 Address.docx"]);
    expect(first.items[0]!.webUrl.startsWith("file:///")).toBe(true);

    expect((await collect(c, first.cursor)).items).toEqual([]);

    await writeFile(join(docs, "UCS", "UC-045 Monitor.docx"), "version two");
    await utimes(join(docs, "UCS", "UC-045 Monitor.docx"), new Date(), new Date(Date.now() + 5000));
    await rm(join(docs, "UCS", "UC-046 Address.docx"));
    await writeFile(join(docs, "UCS", "UC-047 Owners.docx"), "v1");

    const delta = await collect(c, first.cursor);
    const byPath = Object.fromEntries(delta.items.map((i) => [i.path, i.deleted]));
    expect(byPath).toEqual({
      "/UCS/UC-045 Monitor.docx": false,
      "/UCS/UC-047 Owners.docx": false,
      "/UCS/UC-046 Address.docx": true,
    });
    expect((await c.download("UCS/UC-045 Monitor.docx")).toString()).toBe("version two");
  });

  it("refuses folders outside the allowed roots", () => {
    expect(() => new LocalFolderConnector(docs, [join(root, "other")])).toThrow(/outside LOCAL_SOURCE_ROOTS/);
    expect(() => new LocalFolderConnector(docs, [])).toThrow(/outside LOCAL_SOURCE_ROOTS/);
  });

  it("refuses ids that escape the folder", async () => {
    const c = new LocalFolderConnector(docs, [root]);
    await expect(c.download("../secret.txt")).rejects.toThrow(/Invalid id/);
  });
});
