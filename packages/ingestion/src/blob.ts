import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Storage for screenshots (and later rendered videos). Azure Blob / S3 implement the same interface. */
export interface BlobStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Filesystem store for local development. */
export class LocalBlobStore implements BlobStore {
  constructor(private root = process.env.BLOB_DIR ?? ".data/blobs") {}

  async put(key: string, data: Buffer): Promise<void> {
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(join(this.root, key));
  }

  delete(key: string): Promise<void> {
    return rm(join(this.root, key), { force: true });
  }
}
