/** A file or folder change reported by a source. */
export interface SourceItem {
  externalId: string;
  name: string;
  /** Full path from the drive root, e.g. "/Specs/UCS/UC-045 Submissions.docx". */
  path: string;
  webUrl: string;
  isFolder: boolean;
  deleted: boolean;
  /** Content tag: changes only when the file content changes. */
  cTag?: string;
}

export interface ChangePage {
  items: SourceItem[];
  /** Set on the last page; store it and pass it to the next listChanges call. */
  nextCursor?: string;
}

export interface SourceConnector {
  /** Changes since cursor; with no cursor, every item in the source. */
  listChanges(cursor?: string | null): AsyncIterable<ChangePage>;
  download(externalId: string): Promise<Buffer>;
  /** Principal ids (users/groups) with read access. */
  getAcl(externalId: string): Promise<string[]>;
}
