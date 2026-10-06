import { createHash } from "node:crypto";
import {
  signingProvider,
  type CryptographicSigningProvider,
} from "./signing-provider";

export interface IntegrityManifest {
  documentId: string;
  versionId: string;
  sha256: string;
  signingTime: string;
  keyVersion: string;
}
export interface IntegrityService {
  hash(bytes: Uint8Array): Buffer;
  createManifest(
    bytes: Uint8Array,
    identity: Pick<IntegrityManifest, "documentId" | "versionId">,
    signingTime?: Date,
  ): { manifest: IntegrityManifest; signature: Buffer };
  verifyManifest(
    bytes: Uint8Array,
    manifest: IntegrityManifest,
    signature: Uint8Array,
  ): boolean;
}
function canonical(manifest: IntegrityManifest): Buffer {
  return Buffer.from(
    JSON.stringify({
      documentId: manifest.documentId,
      versionId: manifest.versionId,
      sha256: manifest.sha256,
      signingTime: manifest.signingTime,
      keyVersion: manifest.keyVersion,
    }),
  );
}
export class LocalIntegrityService implements IntegrityService {
  constructor(
    private readonly signer: CryptographicSigningProvider = signingProvider,
  ) {}
  hash(bytes: Uint8Array): Buffer {
    return createHash("sha256").update(bytes).digest();
  }
  createManifest(
    bytes: Uint8Array,
    identity: Pick<IntegrityManifest, "documentId" | "versionId">,
    signingTime = new Date(),
  ) {
    const manifest: IntegrityManifest = {
      ...identity,
      sha256: this.hash(bytes).toString("hex"),
      signingTime: signingTime.toISOString(),
      keyVersion: this.signer.keyVersion,
    };
    return {
      manifest,
      signature: Buffer.from(this.signer.signManifest(canonical(manifest))),
    };
  }
  verifyManifest(
    bytes: Uint8Array,
    manifest: IntegrityManifest,
    signature: Uint8Array,
  ): boolean {
    const hashMatches = this.hash(bytes).toString("hex") === manifest.sha256;
    return (
      hashMatches && this.signer.verifyManifest(canonical(manifest), signature)
    );
  }
}
export const integrityService: IntegrityService = new LocalIntegrityService();
