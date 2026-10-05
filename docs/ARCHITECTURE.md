# Rebuild Architecture

This is a proposed architecture for the OD and permission-letter workflow. It is a design for the rebuild, not a claim about the original application's internals.

## Components

- **Web client:** requester editor, signer pages, and audit-history screen. It renders state returned by the server and keeps only transient form/navigation state in the browser.
- **Backend API:** authenticates requesters, validates document ownership, resolves signer tokens, enforces role/order/state transitions, persists audit events, and issues PDF retrieval/verification responses.
- **PostgreSQL:** authoritative state for documents, signers, fields, signatures, document versions, views, audit sequence/head, and notification outbox.
- **Private object storage:** source and sealed PDF versions. Sealed keys are immutable; the database stores object keys and digests, not PDF bytes.
- **PDF worker:** consumes a durable queue/outbox job after the final signer completes; renders fields, applies a certificate-backed PDF signature, computes the final-byte digest, and stores a new immutable sealed version.
- **KMS/HSM-backed key service:** protects the PDF signing key and the audit/integrity manifest signing key. Private key bytes are not returned to the API or browser.
- **Email provider:** sends signer invitations and next-signer notifications. Dispatch uses an outbox so notification errors can be retried independently from a successful state transition.

## Component flow

~~~mermaid
graph LR
  Requester[Requester browser] -->|HTTPS JSON and multipart PDF| API[Backend API]
  Signer[Signer browser] -->|HTTPS token-scoped requests| API
  API -->|transactional queries and writes| DB[(PostgreSQL)]
  API -->|PDF object reads and writes| Store[(Private immutable object storage)]
  API -->|durable outbox job| Queue[(Job queue)]
  Queue -->|seal job| Worker[PDF sealing worker]
  Worker -->|source PDF bytes| Store
  Worker -->|signature request| KMS[KMS or HSM]
  Worker -->|sealed PDF and manifest| Store
  Worker -->|version, digest, audit, final state| DB
  API -->|dispatch outbox| Queue
  Queue -->|email request| Email[Email provider]
  API -->|verified PDF bytes or integrity error| Requester
  API -->|verified PDF bytes or integrity error| Signer
~~~

## State locations

| State | Location | Authority |
|---|---|---|
| Workflow status, owner, letter type, signer roles/order/status | PostgreSQL | Server transaction; client values are not authoritative |
| Field assignments and signature values/records | PostgreSQL | Server validates signer, turn, and field ownership before write |
| Original and sealed PDF bytes | Private object storage | Immutable object key per document version |
| PDF digest and signed manifest | PostgreSQL metadata; manifest signature verified with KMS public key | Recomputed from retrieved bytes before delivery |
| View and signature audit events | PostgreSQL append-only event table | Inserted in the same transaction as the corresponding successful action |
| Audit-chain head and next sequence | PostgreSQL document row | Updated under per-document row lock in the same transaction as event insertion |
| Private signing keys | KMS/HSM | Key service signs; application cannot export key material |
| Queue/outbox entries | PostgreSQL outbox plus worker queue | Durable dispatch and retry; queue is not the authority for workflow state |
| UI drafts, current tab, unsaved input | Browser memory | Temporary only; server validates all submitted data |

## Key decisions

1. **Enforce order in the API transaction.** Every signature-field mutation and completion action locks the document workflow row, reloads signer state, compares the request signer to the single ACTIVE signer, and commits the signature plus state transition atomically. The UI may hide or disable controls, but that is not enforcement.
2. **Freeze sent documents.** Once sent, PDF bytes, field geometry, signer role, and order cannot be edited through requester APIs. Changes require a new document version/draft.
3. **Persist views when bytes are served.** The backend creates a view row and audit event in the same transaction before returning document content. Failed audit persistence fails the content response. Do not cache signer PDF responses in a way that bypasses this handler.
4. **Seal immutable final bytes.** The worker signs the assembled PDF, writes it under a new immutable object key, hashes the exact stored bytes with SHA-256, and creates a signed manifest containing document ID, version ID, digest, and signing time. Only then does a transaction publish the final version pointer and COMPLETED state.
5. **Verify at the trust boundary.** Every final-PDF download and explicit integrity check fetches bytes, recomputes SHA-256, verifies the manifest signature, and compares IDs/digest. On mismatch, do not return the PDF as valid; persist an integrity-failure event and alert the owner.
6. **Make audit history tamper-evident.** Each audit row includes a per-document sequence and previous-event hash. Hash a canonical representation of the event, then sign that event hash with a KMS-held audit key. Verify sequence, hash links, and signatures when displaying or exporting history.
7. **Use idempotent job processing.** A seal job is keyed by document ID and final signer transition. Retrying must not create multiple final versions or duplicate completion events.
8. **Separate identity from role.** A signer has a fixed institutional role and a verified destination/identity. The role order is invariant and cannot be selected by a browser request.

## Killer Test coverage

- **KT1:** PostgreSQL transaction and server-derived ACTIVE signer gate protect both field writes and completion; stale UI, edited request state, or concurrent submissions cannot bypass it.
- **KT2:** The immutable final version has a digest covered by a KMS-signed manifest. Every retrieval recomputes and verifies the digest/signature; modified bytes fail closed.
- **KT3:** A successful content-view response requires a committed view event with a database timestamp. Successful field signature/completion commits include timestamped audit events. The audit chain makes later changes detectable.
