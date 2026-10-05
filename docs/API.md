# API Contract

All paths below are proposed for the rebuild, not copied from the original. JSON examples are omitted; schemas are expressed as field lists. All errors use a stable shape: code, human-readable message, requestId, and optional fieldErrors. Never return stack traces or signing tokens in errors.

## Authentication and shared rules

- Requester endpoints require an authenticated account session and enforce document ownership on every document ID.
- Signer endpoints require a high-entropy bearer link token. Store only its digest; resolve it to one signer and one document. Apply configured email/identity verification before content access or signing.
- The browser cannot provide authoritative signer status, current turn, timestamps, document version, PDF hash, completion status, or audit sequence.
- Validate document state and signer turn in the same database transaction as each mutation.
- Timestamps are generated server-side/database-side. All responses use UTC ISO-8601 timestamps.

## Routes/actions

### Create document and upload PDF

- **Action:** POST /api/documents
- **Input:** multipart PDF file; letterType (OD or PERMISSION); title.
- **Output:** documentId, initialVersionId, upload metadata, status DRAFT.
- **Who may call:** authenticated requester.
- **Authentication/authorization:** account session required; new document owner is the session user.
- **Validation:** PDF media type and parser validation; size/page limits; title and letterType; virus scan if configured.
- **Errors:** 400 invalid form/PDF; 401 unauthenticated; 413 size limit; 415 unsupported media type; 422 corrupt PDF; 503 storage unavailable.
- **State changes:** store immutable source bytes, digest and version row; create DRAFT document. If DB commit fails, clean up unreferenced upload asynchronously.

### Place or update signature fields

- **Action:** PUT /api/documents/{documentId}/fields
- **Input:** array of fieldId (optional for new), signerId, pageNumber, normalized x/y/width/height, fieldType, required.
- **Output:** persisted fields with IDs and assignments.
- **Who may call:** document owner while status is DRAFT.
- **Authentication/authorization:** account session plus owner check.
- **Validation:** all signer IDs belong to this document; page exists; geometry lies within page; signature field has one signer; no mutation after send.
- **Errors:** 401 unauthenticated; 403 not owner; 404 document/signer missing; 409 not editable; 422 invalid page/geometry/type.
- **State changes:** create/update field rows. Record draft configuration audit events if audit policy requires them.

### Assign signers and order

- **Action:** PUT /api/documents/{documentId}/signers
- **Input:** exactly three signers: sequence 1 role STUDENT, sequence 2 role FACULTY_ADVISOR, sequence 3 role HOD; each has fullName and email.
- **Output:** signer IDs, role, sequence, state.
- **Who may call:** document owner while DRAFT.
- **Authentication/authorization:** account session plus owner check.
- **Validation:** exact role/order tuple; no duplicate role, sequence, or email if policy disallows it; required fields assigned to a signer in this document.
- **Errors:** 401; 403; 404; 409 document already sent; 422 role/order or assignment validation errors.
- **State changes:** atomically replace the draft signer set and update assignments. Generate random signer tokens; return links only through protected dispatch.

### Send/start workflow

- **Action:** POST /api/documents/{documentId}/send
- **Input:** optional notification message; idempotency key.
- **Output:** status PENDING, activeSigner role STUDENT, sentAt.
- **Who may call:** document owner.
- **Authentication/authorization:** session plus ownership.
- **Validation:** DRAFT state; source PDF exists; exactly three roles in required order; at least one required signature field for each required signer; all field assignments valid.
- **Errors:** 401; 403; 404; 409 already sent/cancelled; 422 missing fields/signers; 503 notification/outbox failure.
- **State changes:** freeze draft structure, set document PENDING, set Student ACTIVE and the other signers PENDING, persist notification outbox entries and DOCUMENT_SENT audit event in one transaction.

### Retrieve signing page/status

- **Action:** GET /api/sign/{token}
- **Input:** bearer token in protected URL/cookie.
- **Output:** signer role/status, document metadata, active-turn boolean, fields for this signer, safe view URL.
- **Who may call:** matching signer.
- **Authentication/authorization:** token digest resolves to signer; optional configured email verification; no access to another document or signer.
- **Validation:** token active, signer not revoked, document not cancelled, signer not expired.
- **Errors:** 404 invalid token; 410 revoked/expired; 423 cancelled; 428 additional identity verification required.
- **State changes:** none for status read. Viewing actual PDF bytes uses the separate view action below so each content view is durably audited.

### View document PDF

- **Action:** GET /api/sign/{token}/document
- **Input:** bearer token.
- **Output:** PDF bytes and version ID only after the view event commits.
- **Who may call:** any authorized signer on that document, including a signer whose signing turn has not arrived; viewing does not grant signing permission.
- **Authentication/authorization:** valid signer token and configured identity gate.
- **Validation:** document/version exists and is available; verify sealed-file integrity if final, or source version digest if draft/pending.
- **Errors:** 401/404/410/423; 409 integrity mismatch; 503 audit or storage unavailable.
- **State changes:** insert one DocumentView and one DOCUMENT_VIEWED AuditEvent with database timestamp before response. On audit failure, fail the response rather than serving an unlogged view.

### Sign a field

- **Action:** PUT /api/sign/{token}/fields/{fieldId}
- **Input:** signature value or signature asset reference; requestId idempotency key.
- **Output:** persisted signature field state and signedAt.
- **Who may call:** the assigned ACTIVE signer only.
- **Authentication/authorization:** valid signer token, field belongs to that signer and document.
- **Validation:** in a row-locked transaction, document PENDING, signer ACTIVE, role/order expected, field required and writable, signature type matches field, requestId unused or idempotent replay of the same operation.
- **Errors:** 401/404/410; 409 OUT_OF_TURN, ALREADY_SIGNED, DOCUMENT_NOT_PENDING, REPLAY_CONFLICT; 422 invalid signature/field data.
- **State changes:** insert the signature record and FIELD_SIGNED event atomically. A signer may sign only their assigned fields. Define field amendment policy explicitly; default is no overwrite after successful signature.

### Complete current signer

- **Action:** POST /api/sign/{token}/complete
- **Input:** requestId; optional authentication challenge result.
- **Output:** signer state SIGNED; next active role or PROCESSING if final signer.
- **Who may call:** current ACTIVE signer.
- **Authentication/authorization:** same token/identity checks as field signing; server recomputes active signer.
- **Validation:** document PENDING; signer ACTIVE and not previously signed; all required fields assigned to this signer have signatures; all field/signature ownership checks pass.
- **Errors:** 401/404/410; 409 OUT_OF_TURN, ALREADY_SIGNED, DOCUMENT_NOT_PENDING; 422 REQUIRED_FIELDS_MISSING; 503 persistence failure.
- **State changes:** atomically mark signer SIGNED, set signedAt, insert SIGNER_COMPLETED event, and activate next signer. On the third signer, set document PROCESSING and add a durable seal job to the outbox. A retry with the same requestId returns the committed result.

### Seal document (internal worker action)

- **Action:** internal job SealDocument(documentId, finalSignerId, idempotencyKey); not a public endpoint.
- **Input:** document ID, final signer ID, job idempotency key.
- **Output:** final version ID, digest, verification status.
- **Who may call:** trusted worker service identity only.
- **Authentication/authorization:** signed queue message/service identity; revalidate final signer and all required signatures.
- **Validation:** all three signers SIGNED; all required fields have signatures; source version digest matches; document PROCESSING; job has not already published a final version.
- **Errors:** invalid state; missing field/signature; source mismatch; PDF signing failure; KMS/storage/DB unavailable.
- **State changes:** render and cryptographically sign final PDF; write immutable object; calculate SHA-256 over final bytes; sign integrity manifest with KMS; transactionally publish SEALED DocumentVersion, COMPLETED status, completedAt, and DOCUMENT_SEALED audit event. Failed work leaves no published completed version and is retryable.

### Verify/download final document

- **Action:** GET /api/documents/{documentId}/versions/{versionId}/integrity and GET /api/documents/{documentId}/versions/{versionId}/download
- **Input:** document/version IDs; owner session or authorized signer token.
- **Output:** integrity status and digest; download returns bytes only on valid integrity.
- **Who may call:** owner or signer associated with document.
- **Authentication/authorization:** authenticate caller and check document association.
- **Validation:** version is SEALED; recomputed byte digest equals stored digest; KMS signature on canonical manifest verifies; manifest IDs match requested document/version.
- **Errors:** 401/403/404; 409 INTEGRITY_MISMATCH or INVALID_MANIFEST; 503 storage/KMS unavailable.
- **State changes:** every successful response that returns PDF bytes inserts a DocumentView and DOCUMENT_VIEWED event for the authenticated user or signer before returning bytes. On mismatch, append INTEGRITY_FAILED and alert the owner; never return mismatched bytes with a success status.

### Audit history

- **Action:** GET /api/documents/{documentId}/audit-events?afterSequence={n}
- **Input:** document ID and optional pagination cursor.
- **Output:** ordered event sequence with actor, event type, UTC timestamp, relevant entity IDs, and integrity verification status.
- **Who may call:** document owner; associated signers may receive a restricted view according to policy.
- **Authentication/authorization:** session ownership or signer token association; do not expose unrelated documents.
- **Validation:** verify per-document sequence, hash chain, and KMS signature before presenting history.
- **Errors:** 401/403/404; 409 AUDIT_INTEGRITY_FAILED; 503 database/KMS unavailable.
- **State changes:** no mutation for ordinary retrieval. If verification fails, raise incident and record a separately protected integrity alert.
