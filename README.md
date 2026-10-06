# OD Signing Workflow Rebuild

An independent, clean-room implementation of the OD and permission-letter workflow specified in [`docs/`](docs/). The application has no runtime dependency on the researched application.

## Stack

- Next.js 16, React 19, and TypeScript
- PostgreSQL with Drizzle ORM and SQL migrations
- `pdfjs-dist` for PDF parsing and validation; `pdf-lib` for PDF rendering
- Node.js SHA-256 and Ed25519 operations behind local integrity/signing interfaces
- Private local filesystem document storage and PostgreSQL-backed workflow, audit, and outbox state
- Vitest for unit and PostgreSQL integration tests

## Workflow

1. A requester creates an OD or permission document and uploads a PDF.
2. The requester assigns signers in the fixed order **Student → Faculty Advisor → HoD** and places required signature fields.
3. The document is sent. The server determines and enforces the current signing turn; each signer completes their required fields before the next signer becomes active.
4. HoD completion triggers finalization. The final PDF is generated from the persisted source and signatures, sealed through the local provider, and stored separately in private storage.
5. The system hashes the exact stored final-PDF bytes with SHA-256, stores a signed integrity manifest, and marks the document complete only when finalization evidence is persisted.
6. Final-PDF retrieval verifies the stored bytes and manifest before serving the PDF. A mismatch is recorded as `INTEGRITY_FAILED`; the PDF is not served as valid.

The authenticated requester can review access-controlled audit history. Persisted audit events cover document creation/sending, signer and field changes, views, signatures, recipient completion, sealing, and integrity verification/failure. Events carry ordered, chained hash and signing evidence.

## Security and integrity

- Authorization, document ownership, and signer order are enforced on the server.
- Session tokens are signed and checked against PostgreSQL revocation records; logout revokes the presented token as well as clearing the browser cookie.
- Uploaded and final PDFs remain in private storage and are accessed through the application.
- SHA-256 covers the exact stored final-PDF bytes. The associated manifest is signed locally with Ed25519 and verified on retrieval.
- The local Ed25519 implementation is not a production KMS/HSM. The PDF sealing mechanism is not a certificate-backed legal signature, and the application does not use an external trusted timestamp service.
- Local application accounts are provided for the demo. This is not university SSO or institutional identity verification.

## Completeness assistant

The configurable OD completeness assistant highlights potentially missing request information such as purpose, dates, destination/event, and supporting details. Its example rules are advisory configuration, not official university policy, and do not independently authorize or block workflow actions.

## Local setup

Requirements: Node.js 20.9 or newer and a running PostgreSQL instance.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a PostgreSQL database and configure local settings. `npm run setup:local` creates `.env.local` with a fresh development Ed25519 keypair and refuses to overwrite an existing file. Edit its `DATABASE_URL` to match your local database. `.env.example` documents the variable names and sample shapes; it does not contain usable signing keys.

   **Never commit `.env.local`, private keys, credentials, or `.data/`.** `.env.local` is ignored by Git.

3. Apply migrations:

   ```sh
   npm run db:migrate
   ```

4. Start the application and open `http://localhost:3000`:

   ```sh
   npm run dev
   ```

   The health endpoint is `GET /api/health`.

PDF uploads are limited to PDF files up to 10 MB and 50 pages. Local document files are stored under `STORAGE_ROOT` (default `.data/private-documents`) and are not exposed as public storage URLs.

## Useful commands

```sh
npm run dev
npm run build
npm run start
npm run typecheck
npm run lint
npm run format:check
npm test
npm run db:check
npm run db:migrate
```

Database integration tests are gated. Point `DATABASE_URL` at a disposable database with migrations applied and enable them with:

```sh
FOUNDATION_DB_TEST=1 npm test
```

`npm run format` writes formatting changes; use `npm run format:check` for a read-only check.

## Verification notes and limitations

The available evidence includes fresh PostgreSQL migration/test runs and previous KT1, KT2, and KT3 verification. The last completed post-logout-fix database-backed suite reported **65 passed, 0 failed, 0 skipped**; the logout token-revocation regression passed. A later run after adding an extra test assertion was interrupted before its result was received. Typecheck, lint, build, and `db:check` passed before that final assertion change; they were not rerun afterward. Earlier clean-room checks passed.

Browser automation was unavailable during independent Phase 6 verification. Browser interaction, responsive desktop/tablet/mobile behavior, and interactive UI flows therefore do not have full browser-automation coverage. Phase 6 has not been declared independently cleared.
