# OD Signing Workflow Rebuild

## Repository

GitHub owner: **GHOST-031**  
Repository: **Backbenchers-Digital-Signature-Worflow**

## Problem

OD and permission letters require a clear approval path, reliable signature collection, and a trustworthy final document. This rebuild provides a local application workflow for preparing, signing, sealing, retrieving, and auditing those documents.

## Solution

An authenticated requester uploads and prepares a PDF, assigns signers in the fixed **Student → Faculty Advisor → HoD** order, and places the required signature fields. The server enforces the current signing turn. Each signer completes their required fields before the next signer becomes active. HoD completion triggers final PDF generation and sealing; the sealed artifact is stored privately.

## Core Features

- PDF-only upload validation, with 10 MB and 50-page limits
- Requester document creation and ordered signer assignment
- Signature-field placement and ownership
- Typed and drawn signature capture
- Server-enforced signing order and signer completion
- Final PDF rendering, sealing, and private storage
- Exact-byte SHA-256 integrity verification and tamper detection
- Access-controlled document and audit-history retrieval
- Server-side authorization for documents and signer actions
- Configurable OD completeness assistant

## Security and Integrity

The backend is authoritative for document ownership, authorization, workflow state, and signer order. Finalization hashes the exact stored final-PDF bytes and persists an integrity manifest signed with the local Ed25519 provider. Retrieval verifies the PDF bytes and manifest before returning the PDF. If the stored artifact fails verification, retrieval returns an integrity failure, does not serve the PDF as valid, and preserves failure state and audit evidence.

Audit events are persisted with document association, applicable actor, UTC timestamp, per-document sequence, previous/event hashes, and cryptographic signature evidence. Audit history is access-controlled and verified before it is returned.

## Differentiator

The configurable completeness assistant highlights potentially missing information such as request purpose, dates, destination/event, and supporting details. Its example rules are advisory and configurable; they are not official university policy.

## Killer Tests

**KT1 — Signing Order:** Advisor and HoD attempts before Student completion are rejected at the server mutation boundary. Student → Advisor → HoD progression succeeds, and PostgreSQL-backed concurrency tests exercise ordering during concurrent attempts.

**KT2 — PDF Integrity:** An untouched sealed PDF retrieves successfully. A one-byte modification to the actual stored final artifact is detected; retrieval returns `INTEGRITY_FAILED`, serves no PDF as valid, persists and audits the failure, and repeated retrieval remains blocked without adding duplicate failure events.

**KT3 — Audit:** Authorized audit-history retrieval succeeds and unauthorized retrieval is rejected. Lifecycle, signing, sealing, and integrity events include actor/document association where applicable, timestamp, sequence, hash-chain, and signature evidence.

## Verification

- Fresh PostgreSQL databases were used for validation; all **12 current migrations** applied successfully.
- The last completed post-logout-fix database-backed suite reported **65 passed, 0 failed, 0 skipped**. The logout token-revocation regression passed.
- Previous independent workflow verification established KT1, KT2, and KT3.
- Typecheck, lint, build, and `db:check` passed before the final test-only assertion was added. The subsequent suite run was interrupted before its result was received; those checks were not rerun after that assertion.
- Clean-room checks passed previously.

## Limitations

- Authentication uses local application accounts, not university SSO or institutional identity verification.
- Local Ed25519 signing is not a production KMS/HSM and is not a certificate-backed legal digital signature.
- No external trusted timestamp service is integrated.
- Browser automation was unavailable during independent Phase 6 verification. Interactive browser behavior and responsive desktop/tablet/mobile layouts remain unverified; Phase 6 has not been declared independently cleared.
