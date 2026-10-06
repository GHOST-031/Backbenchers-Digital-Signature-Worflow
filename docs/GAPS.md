# Original Gaps and Selected Improvements

## Evidence-backed gaps in the original

| Gap | Evidence | Why it matters to this card | Rebuild response |
|---|---|---|---|
| Field-level signing mutation does not check the recipient's turn. The signing page redirect and completion check do not protect this separate mutation. | documenso/packages/trpc/server/envelope-router/sign-envelope-field.ts:31-64,93-115,201-280; documenso/packages/lib/server-only/document/complete-document-with-token.ts:143-154 | A later signer can mutate their assigned signature field before becoming eligible, even though completion is separately gated. | Validate the ACTIVE signer in the same transaction as every field/signature write. |
| Original role model is generic and does not encode the Student → Faculty Advisor → HoD role set. | documenso/packages/prisma/schema.prisma:623-629,632-668 | Generic ordered recipients do not by themselves ensure the card's institutional roles or exact sequence. | Use fixed institutional role values and validate the exact three-role order before sending. |
| Ordinary seal path signs and stores the final PDF but does not show a later integrity verification in that path. Repository-wide post-seal verification is not established by this evidence. | documenso/packages/lib/jobs/definitions/internal/seal-document.handler.ts:485-510 | The card requires edited-after-signing PDF bytes to be detected. | Store a digest under a signed manifest and re-verify on every final-PDF retrieval. |
| View audit persistence is best effort from the signing page: errors are caught and ignored. | documenso/apps/remix/app/routes/_recipient+/sign.$token+/_index.tsx:268-272; documenso/packages/lib/server-only/document/viewed-document.ts:31-48 | A view can succeed without a persisted view event, which weakens the every-view audit requirement. | Commit view record and audit event before returning PDF content; fail closed on write failure. |
| Audit model has no dedicated chain/hash/signature columns. External immutability controls are Unknown. | documenso/packages/prisma/schema.prisma:517-533 | The schema evidence alone does not establish a tamper-evident audit trail. | Add chained and KMS-signed audit events, restricted append-only storage, and verification on history reads. |
| Sequential next-recipient notification trigger results are ignored after send state is updated. | documenso/packages/lib/server-only/document/complete-document-with-token.ts:527-550 | The next signer may not receive a request while persisted status implies notification was sent. | Use a durable outbox with retry and observable delivery state. |

The original also has positive controls that must not be misreported as gaps: completion checks signer turn; completion guards duplicate transitions; field lookup is token/recipient scoped; required fields are validated; audit/signature timestamps are present. Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:143-154,314-347; documenso/packages/trpc/server/envelope-router/sign-envelope-field.ts:31-64; documenso/packages/prisma/schema.prisma:517-520,714-723.

## Exactly two improvements selected for this rebuild

### Improvement 1 — Fix from Gaps

**Enforce sequential signing at every server mutation.** Every field write and completion call will lock/reload the document state, derive the only ACTIVE signer from persisted order and state, and atomically reject non-active signer mutations before any signature or success audit event is written. This directly fixes the field-level gap supported above and satisfies Killer Test 1.

### Improvement 2 — Differentiator

**OD Request Validation & Completeness Assistant**

Before an OD/permission letter enters the signing workflow, the system validates that the request contains all institution-required information, such as the purpose of the request, dates, destination/event details, and required supporting information. It presents missing or inconsistent information to the student before the document is sent for approval.

This reduces incomplete or incorrect OD requests reaching the Faculty Advisor or HoD and makes the rebuild more useful as an institutional OD workflow rather than only a generic document-signing system.

**Why it matters:** The core rebuild guarantees secure signing; this differentiator improves the quality of the request before signing begins.

**Original-system status:** Unknown. The reverse-engineering stages did not establish whether the original system provides an equivalent institution-specific OD-request validation workflow, so no claim of exclusivity is made.
