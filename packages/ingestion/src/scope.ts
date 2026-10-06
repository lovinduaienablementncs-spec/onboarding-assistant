import picomatch from "picomatch";
import type { SourceItem } from "./connector.js";

export interface ScopeConfig {
  folderPath: string;
  includeGlobs: string[];
  excludeGlobs: string[];
  fileTypes: string[];
}

/** Whether a file belongs to this source's configured folder, globs and file types. */
export function inScope(item: Pick<SourceItem, "path" | "isFolder">, cfg: ScopeConfig): boolean {
  if (item.isFolder) return false;
  const folder = "/" + cfg.folderPath.replace(/^\/+|\/+$/g, "");
  const prefix = folder === "/" ? "/" : `${folder}/`;
  if (!item.path.toLowerCase().startsWith(prefix.toLowerCase())) return false;

  const rel = item.path.slice(prefix.length);
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (!cfg.fileTypes.includes(ext)) return false;
  if (rel.split("/").some((part) => part.startsWith("~$"))) return false; // Office lock files

  const opts = { nocase: true, dot: false };
  if (!picomatch(cfg.includeGlobs, opts)(rel)) return false;
  return !(cfg.excludeGlobs.length && picomatch(cfg.excludeGlobs, opts)(rel));
}
