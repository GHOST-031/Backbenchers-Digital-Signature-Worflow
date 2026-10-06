# Observations of the Original

Scope: source-backed findings relevant to the digital-signature workflow. These describe the original application; they are not a specification for the rebuild. “Likely” means the cited code strongly indicates the behavior but does not prove a repository-wide absence.

## Routes and document preparation

- The Remix app registers route files using flat route discovery under its routes directory.
  Evidence: documenso/apps/remix/app/routes.ts:1-12 [Confirmed]

- The root route redirects authenticated users to a team documents route and unauthenticated users to sign-in.
  Evidence: documenso/apps/remix/app/routes/_index.tsx:11-51 [Confirmed]

- The team documents page renders an envelope drop-zone wrapper; the wrapper calls the envelope create mutation and navigates to the editor.
  Evidence: documenso/apps/remix/app/routes/_authenticated+/t.$teamUrl+/documents._index.tsx:178-181; documenso/apps/remix/app/components/general/envelope/envelope-drop-zone-wrapper.tsx:53-53,57-100 [Confirmed]

- The authenticated create-envelope route normalizes an uploaded PDF, stores its bytes through the server file helper, and passes the resulting data reference into envelope creation.
  Evidence: documenso/packages/trpc/server/envelope-router/create-envelope.ts:22-40,123-140,171-192 [Confirmed]

- The editor includes document/recipient, field-placement, and preview steps.
  Evidence: documenso/apps/remix/app/components/general/envelope-editor/envelope-editor.tsx:52-70,104-122 [Confirmed]

- The document logs page obtains a session and scopes the envelope lookup by user and team identifiers.
  Evidence: documenso/apps/remix/app/routes/_authenticated+/t.$teamUrl+/documents.$id.logs.tsx:27-58 [Confirmed]

## Recipients, order, and fields

- The schema has generic recipient roles including SIGNER, VIEWER, APPROVER, ASSISTANT, and CC; it has no Student, Faculty Advisor, or HoD enum values.
  Evidence: documenso/packages/prisma/schema.prisma:623-629 [Confirmed]

- Recipient rows contain generic role, signingOrder, readStatus, signingStatus, sentAt, and signedAt fields.
  Evidence: documenso/packages/prisma/schema.prisma:632-668 [Confirmed]

- Document metadata stores PARALLEL or SEQUENTIAL signing order; each recipient may store an integer signing order.
  Evidence: documenso/packages/prisma/schema.prisma:542-545,568-569,648 [Confirmed]

- The signing-page loader redirects an out-of-turn recipient to a waiting route.
  Evidence: documenso/apps/remix/app/routes/_recipient+/sign.$token+/_index.tsx:224-228 [Confirmed]

- The completion helper independently checks turn on sequential documents and rejects an out-of-turn completion request.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:143-154 [Confirmed]

- The field-sign mutation identifies a recipient by token and scopes the field lookup to that recipient (with the code's explicit assistant exception); it checks pending document status, expiration, and whether the recipient has already completed signing.
  Evidence: documenso/packages/trpc/server/envelope-router/sign-envelope-field.ts:31-64,93-115 [Confirmed]

- The field-sign mutation does not check whether the recipient is currently in turn before updating the field and signature. The completion helper's check therefore does not establish field-level enforcement.
  Evidence: documenso/packages/trpc/server/envelope-router/sign-envelope-field.ts:17-21,31-64,93-115,201-280; documenso/packages/lib/server-only/document/complete-document-with-token.ts:143-154 [Confirmed]

- A signature field write upserts a Signature row keyed by fieldId and writes a field-inserted audit event in the same transaction.
  Evidence: documenso/packages/trpc/server/envelope-router/sign-envelope-field.ts:201-230,238-280 [Confirmed]

- Completion checks required fields, conditionally changes a recipient to SIGNED with signedAt, and creates a DOCUMENT_RECIPIENT_COMPLETED audit event.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:314-347,387-405 [Confirmed]

- The helper prevents two concurrent completion requests for one recipient from both proceeding by conditionally updating only a recipient not already marked SIGNED.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:321-347 [Confirmed]

- For sequential signing, the completion flow finds pending recipients, updates next-recipient send state, and attempts to trigger signing-request email jobs.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:427-475,527-550 [Confirmed]

- Next-recipient email job trigger results are passed to Promise.allSettled and are not examined in the cited flow.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:527-550 [Confirmed]

## PDF processing, sealing, and integrity

- When all recipients are signed or are CC recipients, the completion flow triggers the internal seal-document job.
  Evidence: documenso/packages/lib/server-only/document/complete-document-with-token.ts:557-575 [Confirmed]

- The seal job retrieves document data, renders fields, signs the ordinary PDF path using signPdf, stores the output, updates the envelope-item document-data reference, marks the envelope completed, and writes a DOCUMENT_COMPLETED audit row.
  Evidence: documenso/packages/lib/jobs/definitions/internal/seal-document.handler.ts:196-203,277-316,485-510 [Confirmed]

- The ordinary seal path cited above does not perform a later verification of the stored final PDF in that path. This citation does not prove repository-wide absence of verification.
  Evidence: documenso/packages/lib/jobs/definitions/internal/seal-document.handler.ts:485-510 [Likely]

- CSC/TSP preparation stores a per-item hashB64 and pins rendered document data; CSC/TSP signing later re-derives the digest and compares it with the stored value, raising an error when they differ.
  Evidence: documenso/packages/ee/server-only/signing/csc/prepare-recipient-signing.ts:158-211; documenso/packages/ee/server-only/signing/csc/execute-tsp-sign.ts:211-253 [Confirmed]

- That CSC/TSP comparison checks the prepared bytes at signing time. It does not prove that the ordinary signing path detects edits to a completed PDF.
  Evidence: documenso/packages/ee/server-only/signing/csc/execute-tsp-sign.ts:234-253; documenso/packages/lib/jobs/definitions/internal/seal-document.handler.ts:485-510 [Confirmed]

## Audit and timestamps

- The recipient signing loader calls viewedDocument after access, turn, completion, rejection, and expiration checks, and catches errors from that call.
  Evidence: documenso/apps/remix/app/routes/_recipient+/sign.$token+/_index.tsx:224-272 [Confirmed]

- viewedDocument creates a DOCUMENT_VIEWED row. On first open it also updates recipient read state and creates DOCUMENT_OPENED.
  Evidence: documenso/packages/lib/server-only/document/viewed-document.ts:31-48,50-87 [Confirmed]

- Because the signing loader catches view-recording errors, a rendered signing page does not prove that its view event persisted.
  Evidence: documenso/apps/remix/app/routes/_recipient+/sign.$token+/_index.tsx:268-272; documenso/packages/lib/server-only/document/viewed-document.ts:31-48 [Confirmed]

- DocumentAuditLog.createdAt and Signature.created have database defaults of now(); recipient completion assigns signedAt from a server-side Date.
  Evidence: documenso/packages/prisma/schema.prisma:517-520,714-723; documenso/packages/lib/server-only/document/complete-document-with-token.ts:325-338 [Confirmed]

- The document logs page renders a table that queries audit history and displays time, user, action, IP address, and browser.
  Evidence: documenso/apps/remix/app/routes/_authenticated+/t.$teamUrl+/documents.$id.logs.tsx:194-196; documenso/apps/remix/app/components/tables/document-logs-table.tsx:37-46,65-118 [Confirmed]

- The DocumentAuditLog schema has no dedicated event-hash, previous-hash, or signature columns. Database-level immutability controls are Unknown.
  Evidence: documenso/packages/prisma/schema.prisma:517-533 [Confirmed]

## Relevant schema relationships

- Envelope.userId and teamId are required foreign keys; Envelope.documentMetaId is required and unique. DocumentMeta's reverse relation is optional.
  Evidence: documenso/packages/prisma/schema.prisma:475-486,586-586 [Confirmed]

- EnvelopeItem.documentDataId is required and unique; DocumentData's reverse EnvelopeItem relation is optional.
  Evidence: documenso/packages/prisma/schema.prisma:498-515,547-553 [Confirmed]

- DocumentAuditLog.envelopeId is nullable, and its relation to Envelope is optional.
  Evidence: documenso/packages/prisma/schema.prisma:517-533 [Confirmed]

- Recipient has many Signature rows through Signature.recipientId, which is indexed but not unique; Signature.fieldId is unique, so a Field has at most one Signature.
  Evidence: documenso/packages/prisma/schema.prisma:632-668,714-725 [Confirmed]

- CscCredential.recipientId and CscSession.recipientId are unique foreign keys; CscSession.envelopeId is a denormalized string without a Prisma relation.
  Evidence: documenso/packages/prisma/schema.prisma:732-755,761-792 [Confirmed]

- The ordinary seal flow replaces an EnvelopeItem's DocumentData reference with a new one. A linked version-history model is not shown by the cited relation or seal path; other retention behavior is Unknown.
  Evidence: documenso/packages/lib/jobs/definitions/internal/seal-document.handler.ts:291-301; documenso/packages/prisma/schema.prisma:498-515,547-553 [Likely]

## Stage 8 correction

- A prior statement that hashB64 had no proven later verification was incorrect: executeTspSign reads it and compares it with a recomputed digest. This is CSC/TSP prep-to-sign verification, not general post-signing PDF tamper detection.
  Evidence: documenso/packages/ee/server-only/signing/csc/execute-tsp-sign.ts:211-253 [Confirmed]

- Marketing screenshots from the prior stage could not be matched to routed screens; the root-route redirect alone does not prove where those pages originate.
  Evidence: documenso/apps/remix/app/routes/_index.tsx:11-51 [Confirmed]
