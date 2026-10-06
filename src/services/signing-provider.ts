import { sign, verify, type KeyLike } from "node:crypto";
import { config } from "@/config/env";
import type { AuditSigningProvider } from "./audit";

export interface CryptographicSigningProvider extends AuditSigningProvider {
  signManifest(bytes: Uint8Array): Uint8Array;
  verifyManifest(bytes: Uint8Array, signature: Uint8Array): boolean;
  verifyAudit(bytes: Uint8Array, signature: Uint8Array): boolean;
  readonly keyVersion: string;
}
export class LocalEd25519SigningProvider implements CryptographicSigningProvider {
  readonly keyVersion = "local-ed25519-v1";
  private readonly privateKey: KeyLike;
  private readonly publicKey: KeyLike;
  constructor(
    privatePem = Buffer.from(config.SIGNING_PRIVATE_KEY_B64, "base64"),
    publicPem = Buffer.from(config.SIGNING_PUBLIC_KEY_B64, "base64"),
  ) {
    this.privateKey = privatePem;
    this.publicKey = publicPem;
  }
  signManifest(bytes: Uint8Array): Uint8Array {
    return sign(null, bytes, this.privateKey);
  }
  signAudit(bytes: Uint8Array): Uint8Array {
    return sign(null, bytes, this.privateKey);
  }
  verifyManifest(bytes: Uint8Array, signature: Uint8Array): boolean {
    return verify(null, bytes, this.publicKey, signature);
  }
  verifyAudit(bytes: Uint8Array, signature: Uint8Array): boolean {
    return verify(null, bytes, this.publicKey, signature);
  }
}
export const signingProvider: CryptographicSigningProvider =
  new LocalEd25519SigningProvider();
