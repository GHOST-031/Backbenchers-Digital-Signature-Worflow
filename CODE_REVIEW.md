# HACKBACK code review · DBG-622 · Digital Signature Workflow
- Reviewed at: 2026-10-06T08:58:26Z (2026-10-06T14:28:26+05:30 IST)
- Judged commit: 3622b50b1babe3b481c688b101785d4854ba1c89 (2026-10-06T13:20:12+05:30) · the last commit before the code freeze
- Reviewer: AI agent run by a HACKBACK judge

### DBG-622 · Digital Signature Workflow
Commit: `3622b50b1babe3b481c688b101785d4854ba1c89` · 2026-10-06 13:20:12 IST · Clean-room: OK

| Section | Score | Why (path:line) |
|---|---:|---|
| A. Core flow | 27/30 | The connected flow validates and privately stores uploaded PDFs (`src/app/api/documents/route.ts:95-151,179-205`), saves ordered signers and fields (`src/app/api/documents/[documentId]/signers/route.ts:68-151`; `src/app/api/documents/[documentId]/fields/route.ts:43-99,139-201`), enforces signing order (`src/services/sequential-signing.ts:64-92`), and renders/stores final PDFs with integrity evidence (`src/services/finalization.ts:219-274,329-397`). Audit views and final retrieval are wired (`src/app/api/documents/[documentId]/source/route.ts:161-205`). Deduction: the local PDF seal changes metadata only; it is not a PDF signature (`src/services/pdf.ts:17-24`). |
| B. Killer Tests | 18/30 | Server logic and PostgreSQL integration tests cover the three killers: out-of-turn mutations (`tests/sequential-signing.integration.test.ts:214-254`), an actual one-byte stored-artifact edit (`tests/finalization.integration.test.ts:571-620`), and lifecycle audit assertions (`tests/finalization.integration.test.ts:454-475`). These tests are database-gated and were skipped in this review’s run, so I score each as partial rather than live-proven. |
| C. Two improvements | 20/20 | Improvement 1, mutation-boundary order enforcement, is implemented in the signing service (`src/services/sequential-signing.ts:64-92,328-341`). Improvement 2, the configurable completeness assistant, reads example rules and gives advisory guidance (`src/app/documents/[documentId]/completeness-assistant.tsx:15-42,49-63,132-135`; `src/config/od-rules.example.json:1-9`). |
| D. Built from their docs | 8/10 | Core workflow entities and constraints align with the PRD/data model (`src/db/schema.ts:112-180,236-325`; `src/services/sequential-signing.ts:110-199`). The implementation uses signed application sessions for signers, while the API spec calls for signer-specific bearer tokens and protected token dispatch (`docs/API.md:7-10,61-68,83-90`; `src/app/api/sign/[documentId]/route.ts:6-16`; `src/app/api/documents/[documentId]/signers/route.ts:97-130`). |
| E. Engineering | 7/10 | Server-side ownership/state checks, input validation, parsed PDF limits, hashed passwords, and generic route errors are present (`src/app/api/documents/[documentId]/fields/route.ts:43-99`; `src/services/pdf.ts:65-92`; `src/services/auth.ts:91-109`; `.env.example:1-8`). The default `npm test` run had 33 passed, 1 failed, and 31 skipped: the upload-validation test expected 415 but got 401 (`tests/document-phase.test.ts:222-240`). The default test setup targets `od_signing_test` (`tests/setup.ts:3-4`), which was not found in the local database; session lookup fails closed on revocation-store errors (`src/services/auth.ts:160-175`). Signer token digests are generated but the raw tokens are not dispatched or resolved by the signing routes (`src/app/api/documents/[documentId]/signers/route.ts:97-130`; `src/services/sequential-signing.ts:94-107`). |
| Total | 80/100 | |

Killer Tests:

1. PARTIAL · 6/10 · The service derives the current signer from locked database state; the integration test directly invokes the signing routes and checks rejected attempts leave no signatures (`src/services/sequential-signing.ts:40-92`; `tests/sequential-signing.integration.test.ts:214-254`). PostgreSQL test was skipped in this run.
2. PARTIAL · 6/10 · Retrieval verifies the stored PDF and manifest before responding, and the test changes one byte in the actual stored file and checks failure persists across retry (`src/app/api/documents/[documentId]/source/route.ts:61-107,109-158`; `tests/finalization.integration.test.ts:571-620`). PostgreSQL test was skipped in this run.
3. PARTIAL · 6/10 · Views and integrity-verification events are written before bytes are returned, and the audit-history route verifies the chain (`src/app/api/documents/[documentId]/source/route.ts:161-205`; `src/app/api/documents/[documentId]/audit-events/route.ts:85-109`). Lifecycle assertions exist in the integration test (`tests/finalization.integration.test.ts:454-475`), but that test was skipped in this run.

Improvements:

1. Enforce sequential signing at every server mutation · 10/10 · The service locks workflow state and rejects a non-active signer (`src/services/sequential-signing.ts:40-92`); the direct-route test covers early Advisor/HoD attempts (`tests/sequential-signing.integration.test.ts:230-254`).
2. Configurable OD Request Validation & Completeness Assistant · 10/10 · Rules are configuration data, and the UI describes them as non-official advisory checks that do not block sending (`src/config/od-rules.example.json:1-9`; `src/app/documents/[documentId]/completeness-assistant.tsx:60-63,132-135`).

Flags: A stale “Foundation preview” page remains in `src/app/dashboard/page 2.tsx:13-21`; it is separate from the working dashboard. The commit history shows the initial commit contained docs only (`68e1ee7`, 2026-10-05 22:49:58 IST), and the first implementation commit is dated 2026-10-06 13:16:06 IST. No commits after the 13:30 cutoff appear in local Git history. Push timestamps are not recorded there, so push timing is not found.

Questions for the judges’ Defence:

1. The local PDF provider only updates PDF metadata while the integrity manifest is signed separately. What exactly does “sealed” mean in this implementation? (`src/services/pdf.ts:17-24`; `src/services/integrity.ts:45-69`)
2. The API spec calls for signer bearer tokens, but the app routes use application sessions and signer-token digests are not dispatched. How do signers receive access, and why does this differ from the API contract? (`docs/API.md:61-68`; `src/app/api/documents/[documentId]/signers/route.ts:97-130`; `src/app/api/sign/[documentId]/route.ts:6-16`)
3. Can the team run the full database-gated suite against a freshly migrated `od_signing_test` database and make the default upload-validation test pass? (`tests/setup.ts:3-4`; `tests/document-phase.test.ts:222-250`)

SCORE core=27 kt=18 imp=20 docs=8 eng=7 total=80
