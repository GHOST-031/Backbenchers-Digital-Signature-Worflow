# Product Requirements — OD and Permission Letter Signing

## 1. Problem

OD and permission letters require signatures from three university roles in a fixed order: Student, Faculty Advisor, then Head of Department (HoD). A workflow that does not enforce this order can accept an invalid approval sequence; a final PDF that can be silently changed or an incomplete audit trail cannot provide the required evidence.

## 2. Target user

- Primary: a student requesting an OD or permission letter.
- Signers: the Student, their Faculty Advisor, and the HoD.
- Workflow owner: the staff member or student who creates the request and supplies the PDF. The organization-specific identity and permission policy for this owner is a product decision; do not assume a registrar or administrator role.

## 3. One-line problem statement

For students who need OD and permission letters approved by the right university authorities in order, the OD Signing Workflow coordinates signatures and produces a verifiable final PDF, unlike manual paper or email circulation.

## 4. Core user flow

1. An authenticated requester creates an OD or permission-letter request and uploads its PDF.
2. The requester assigns required signature fields to the Student, Faculty Advisor, and HoD.
3. The server validates exactly those three roles in that sequence and freezes the draft.
4. The server invites the Student and marks only the Student ACTIVE.
5. Each signer views the current document through a token-scoped page; each successful view is persisted with a timestamp.
6. The active signer fills their assigned required fields and submits completion.
7. The server checks turn, identity/access, required fields, and document state in a transaction; it records the signature and audit event before activating the next signer.
8. After the HoD signs, a worker seals the final PDF, records its digest and signed integrity manifest, and marks the document COMPLETED.
9. Any final-PDF retrieval recomputes and verifies integrity before returning bytes. The requester and authorized signers can view the ordered audit history.

## 5. Features ranked using MoSCoW

### Must

- Upload and retain the source PDF.
- Create signature fields with page, geometry, type, required status, and exactly one assigned signer.
- Require roles and order Student (1), Faculty Advisor (2), HoD (3); reject missing, duplicated, or reordered roles.
- Enforce the active signer on every server-side signing and completion mutation.
- Persist every document view and every signature/completion event with server/database-generated UTC timestamps.
- Seal a final PDF and detect any byte modification before download or verification response.
- Keep audit events append-only and cryptographically tamper-evident.
- Prevent finalization until every required signer and field is complete.
- Show clear pending, failed, completed, and integrity-failure states.

### Should

- Notify the next signer only after the previous signer completes; retry failed notification dispatch.
- Provide an authorized audit-history view and downloadable final PDF.
- Retain immutable source and final PDF versions with explicit version numbers.
- Provide owner-visible delivery and integrity-verification status.

### Could

- Add optional email one-time verification for signers.
- Allow a requester to cancel a draft before it is sent.
- Provide a printable audit certificate.

### Won't

- Support arbitrary recipient roles or parallel-signing workflows in the first release.
- Treat the browser as authoritative for signing order, completion, timestamps, or document integrity.
- Support templates, general-purpose e-signature APIs, or unrelated document workflows in the first release.

## 6. Out of scope

- General contract-management features.
- University directory provisioning or single sign-on; integration details are Unknown and should be decided separately.
- Legal-policy claims about whether a particular signature method is legally sufficient.
- Offline signing.
- Multi-document envelopes and arbitrary custom recipient roles.

## 7. Acceptance criteria

### Killer Test 1 — Signer 2 and 3 cannot sign early

- **Given:** a sent document has Student ACTIVE and Faculty Advisor and HoD PENDING. **When:** Faculty Advisor or HoD submits a signature-field mutation or completion request. **Then:** the server returns an out-of-turn error, changes no signature/field/signer state, writes no successful-signature audit event, and leaves Student ACTIVE.
- **Given:** Student has completed all required fields and the completion transaction commits. **When:** the state transition is processed. **Then:** Student becomes SIGNED and Faculty Advisor becomes the only ACTIVE signer.
- **Given:** Faculty Advisor is SIGNED. **When:** the transition commits. **Then:** HoD becomes the only ACTIVE signer.
- **Given:** a signer changes client-side state or sends a request from a stale page. **When:** the mutation reaches the server. **Then:** the server derives eligibility from persisted state and does not trust client-reported order or status.

### Killer Test 2 — Edited PDF is detected

- **Given:** a sealed final PDF and its signed integrity manifest. **When:** the stored/downloaded PDF bytes differ by even one byte from the sealed digest. **Then:** verification returns INTEGRITY_MISMATCH, the PDF is not delivered as valid, an integrity-failure audit event is persisted, and the owner is shown a clear failure state.
- **Given:** the PDF bytes and manifest are unchanged and the manifest signature verifies against the configured public key. **When:** verification runs. **Then:** it returns VALID with document ID and version ID.
- **Given:** a worker is sealing a document. **When:** any required field is missing or PDF signing/storage fails. **Then:** the document is not marked COMPLETED and no valid final-version pointer is published.

### Killer Test 3 — Every view and signature has a timestamp

- **Given:** an authorized signer requests document content. **When:** the server returns the document bytes. **Then:** one immutable DOCUMENT_VIEWED event is persisted for that request with document ID, signer ID, document version ID, and server-generated UTC timestamp.
- **Given:** an active signer submits a required signature and completion succeeds. **When:** the transaction commits. **Then:** a FIELD_SIGNED event and signature record both have server/database-generated UTC timestamps and identify the signer, field, and document.
- **Given:** a view or signature event cannot be persisted. **When:** the request is processed. **Then:** the server does not report the corresponding action as successfully completed.
- **Given:** an authorized user requests audit history. **When:** results are returned. **Then:** view and signature events are ordered by per-document sequence and display their persisted timestamps.
