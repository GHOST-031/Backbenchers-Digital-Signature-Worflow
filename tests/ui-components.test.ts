import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DocumentList } from "../src/app/dashboard/document-list";
import { VerifiedAuditTimeline } from "../src/app/documents/[documentId]/audit-history";

describe("dashboard UI", () => {
  it("renders completed and integrity-failed states with safe next actions", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentList, {
        documents: [
          {
            id: "doc-complete",
            title: "Conference request",
            letter_type: "OD",
            status: "COMPLETED",
            created_at: "2026-10-01T10:00:00Z",
            completed_at: "2026-10-02T10:00:00Z",
            signer_count: 3,
            field_count: 3,
            active_role: null,
            signed_count: 3,
          },
          {
            id: "doc-failed",
            title: "Failed integrity check",
            letter_type: "PERMISSION",
            status: "INTEGRITY_FAILED",
            created_at: "2026-10-01T10:00:00Z",
            completed_at: null,
            signer_count: 3,
            field_count: 3,
            active_role: null,
            signed_count: 3,
          },
        ],
      }),
    );
    expect(html).toContain("Completed");
    expect(html).toContain("Sealed final document");
    expect(html).toContain("Integrity failed");
    expect(html).toContain("Integrity review required");
    expect(html).toContain("/documents/doc-complete");
  });

  it("renders an actionable empty state", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentList, { documents: [] }),
    );
    expect(html).toContain("No requests yet");
    expect(html).toContain("Create your first request");
  });

  it("shows lifecycle events only after the backend marks the chain valid", () => {
    const events = [
      {
        id: "audit-1",
        sequence: "1",
        actorType: "REQUESTER",
        actorUserId: "user-1",
        actorSignerId: null,
        eventType: "DOCUMENT_SEALED",
        occurredAt: "2026-10-02T10:00:00Z",
        details: {},
      },
      {
        id: "audit-2",
        sequence: "2",
        actorType: "SIGNER",
        actorUserId: null,
        actorSignerId: "signer-1",
        eventType: "FIELD_SIGNED",
        occurredAt: "2026-10-02T10:01:00Z",
        details: {},
      },
    ];
    const verified = renderToStaticMarkup(
      createElement(VerifiedAuditTimeline, {
        events,
        integrity: "VALID",
        signerRoles: { "signer-1": "Faculty Advisor" },
      }),
    );
    expect(verified).toContain("Final PDF sealed");
    expect(verified).toContain("Requester");
    expect(verified).toContain("Faculty Advisor");
    expect(verified).not.toContain("audit-1");
    const unverified = renderToStaticMarkup(
      createElement(VerifiedAuditTimeline, { events, integrity: "INVALID" }),
    );
    expect(unverified).toContain("Audit verification was not confirmed");
    expect(unverified).not.toContain("Final PDF sealed");
  });
});
