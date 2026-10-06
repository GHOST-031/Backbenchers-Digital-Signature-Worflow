import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { config } from "@/config/env";

export interface DocumentStorage {
  put(bytes: Uint8Array, kind: "source" | "sealed"): Promise<string>;
  putSignature(bytes: Uint8Array): Promise<string>;
  get(key: string): Promise<Buffer>;
  removeSource(key: string): Promise<void>;
  removeSealed(key: string): Promise<void>;
  removeSignature(key: string): Promise<void>;
}
export class FilesystemDocumentStorage implements DocumentStorage {
  readonly root: string;
  constructor(root = config.STORAGE_ROOT) {
    this.root = path.resolve(root);
  }
  private resolve(key: string): string {
    if (
      !/^(source|sealed)\/[a-f0-9-]+\.pdf$/.test(key) &&
      !/^signatures\/[a-f0-9-]+\.png$/.test(key)
    )
      throw new Error("Invalid storage key");
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(`${this.root}${path.sep}`))
      throw new Error("Storage key escapes private root");
    return resolved;
  }
  async put(bytes: Uint8Array, kind: "source" | "sealed"): Promise<string> {
    const key = `${kind}/${randomUUID()}.pdf`;
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
  async putSignature(bytes: Uint8Array): Promise<string> {
    const key = `signatures/${randomUUID()}.png`;
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  }
  async removeSource(key: string): Promise<void> {
    if (!key.startsWith("source/")) {
      throw new Error("Only source documents may be removed");
    }
    await unlink(this.resolve(key));
  }
  async removeSealed(key: string): Promise<void> {
    if (!key.startsWith("sealed/")) {
      throw new Error("Only sealed documents may be removed");
    }
    await unlink(this.resolve(key));
  }
  async removeSignature(key: string): Promise<void> {
    if (!key.startsWith("signatures/"))
      throw new Error("Invalid signature key");
    await unlink(this.resolve(key));
  }
}
export const documentStorage: DocumentStorage = new FilesystemDocumentStorage();
