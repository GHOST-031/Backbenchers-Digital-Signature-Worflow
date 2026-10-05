# Agent Log

## Purpose and rules

- Reverse-engineer only source behavior relevant to the digital-signature card.
- Keep original-application observations separate from rebuild requirements.
- Do not copy source code or edit the original Documenso checkout.
- Preserve exact file/line evidence for original-product claims; label uncertain claims Likely or Unknown.
- Create these seven Markdown files in the new rebuild workspace only.

## Important prompts and decisions

- Stages 0–4 requested repository reconnaissance, workflow architecture, routed screens, and schema/cardinality analysis. The rebuild keeps the verified generic-recipient model as an observation; it does not copy that model as a requirement.
- Stage 4 corrections established that Envelope.documentMetaId and EnvelopeItem.documentDataId are required unique references with optional reverse relations; DocumentAuditLog.envelopeId is nullable; Signature.recipientId is non-unique while Signature.fieldId is unique; CSC credential/session recipient references are unique; CscSession.envelopeId is denormalized.
- Stage 5 traced viewing, field writes, completion, sealing, and CSC signing. The rebuild design treats field signing and completion as separate server-side state transitions.
- Stage 6 reviewed screenshots and the app journey. The screenshots were not matched to routed application screens. The actual editor, signer, waiting, completion, and log routes/components were traced separately.
- Stage 7 reviewed gaps and retained only source-backed findings: missing turn check in field-sign mutation, generic recipient role model, no shown ordinary-path post-seal verification, swallowed view-audit errors, and ignored notification-trigger results.
- Stage 8 required claim-by-claim verification. Route and data-model claims were re-opened against source instead of treated as true because they had appeared earlier.
- Stage 9 asks for a rebuild specification with precise testable acceptance criteria, not a source-code port.

## Important correction

An earlier statement that CSC session hashB64 had no proven later verification was wrong. prepareRecipientSigning records the digest; executeTspSign recomputes and compares it before the signing operation. This proves CSC/TSP prep-to-sign integrity checking only. It does not prove general post-signing verification of the ordinary PDF workflow.

Evidence: documenso/packages/ee/server-only/signing/csc/prepare-recipient-signing.ts:194-211; documenso/packages/ee/server-only/signing/csc/execute-tsp-sign.ts:234-253.

## Decisions for the rebuild

- Enforce signer turn in the API that writes a signature field, not only in UI or completion.
- Make Student, Faculty Advisor, and HoD explicit roles and require the exact sequence.
- Store immutable PDF versions and verify final bytes against a KMS-signed manifest on retrieval.
- Persist each view and signature with a server/database timestamp in the same transaction as the corresponding successful action.
- Make audit history append-only and tamper-evident with sequence, hash chaining, and signing-key verification.
- Keep the browser as presentation state only; all signer eligibility and document status comes from the database and backend.

## Resolved and remaining uncertainties

- Confirmed: completion-level turn enforcement exists in the original; field-level turn enforcement is not shown in the field mutation.
- Confirmed: ordinary sealing calls signPdf and stores the output; post-seal integrity verification in that ordinary path is not shown.
- Confirmed: CSC/TSP has a prep-to-sign digest comparison.
- Confirmed: audit timestamps have schema defaults; this alone does not guarantee every event write succeeds.
- Unknown: database/object-store deployment immutability controls in the original.
- Unknown: whether separate original features can be configured to approximate a university-specific workflow; the source role enum itself is generic.
- Likely: the ordinary seal operation does not maintain a linked version-history relation through EnvelopeItem; this documentation treats explicit version history as a rebuild requirement rather than asserting that all old bytes are deleted.
- Unknown: exact legal signature policy and institution-specific identity provider requirements; define with the deploying institution.
