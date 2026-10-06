import type { AuthenticatedIdentity } from "./auth";
export interface SignerIdentity {
  signerId: string;
  documentId: string;
  role: "STUDENT" | "FACULTY_ADVISOR" | "HOD";
  status: "PENDING" | "ACTIVE" | "SIGNED" | "REVOKED";
}
export interface AuthorizationService {
  ownsDocument(identity: AuthenticatedIdentity, ownerUserId: string): boolean;
  isSignerForDocument(
    signer: SignerIdentity | null,
    documentId: string,
  ): signer is SignerIdentity;
  maySign(signer: SignerIdentity | null, documentId: string): boolean;
}
export class DefaultAuthorizationService implements AuthorizationService {
  ownsDocument(identity: AuthenticatedIdentity, ownerUserId: string): boolean {
    return identity.userId === ownerUserId;
  }
  isSignerForDocument(
    signer: SignerIdentity | null,
    documentId: string,
  ): signer is SignerIdentity {
    return (
      signer !== null &&
      signer.documentId === documentId &&
      signer.status !== "REVOKED"
    );
  }
  maySign(signer: SignerIdentity | null, documentId: string): boolean {
    return (
      this.isSignerForDocument(signer, documentId) && signer.status === "ACTIVE"
    );
  }
}
export const authorizationService: AuthorizationService =
  new DefaultAuthorizationService();
