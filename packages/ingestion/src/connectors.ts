import type { SourceConnector } from "./connector.js";
import { LocalFolderConnector } from "./local.js";
import { OneDriveConnector } from "./onedrive.js";

/** Builds the connector for a source row or config. */
export function createConnector(source: { connector: string; driveId: string }): SourceConnector {
  switch (source.connector) {
    case "onedrive":
      return new OneDriveConnector(source.driveId);
    case "local":
      return new LocalFolderConnector(source.driveId);
    default:
      throw new Error(`Unsupported connector ${source.connector}`);
  }
}
