import { describe, expect, it } from "vitest";
import rules from "../src/config/od-rules.example.json";
import {
  checkRequestCompleteness,
  canPresentSigningActions,
  canShowDocumentPreview,
  documentCreationOutcome,
  documentStatusLabel,
  signerProgress,
  signatureSubmission,
} from "../src/app/ui-models";

describe("UI workflow presentation models", () => {
  it("labels only persisted document states", () => {
    expect(documentStatusLabel("DRAFT")).toBe("Draft");
    expect(documentStatusLabel("PROCESSING")).toBe("Finalizing");
    expect(documentStatusLabel("INTEGRITY_FAILED")).toBe("Integrity failed");
    expect(documentStatusLabel("COMPLETED")).toBe("Completed");
  });

  it("orders progress by persisted sequence and reflects signer status", () => {
    expect(
      signerProgress([
        { sequence: 3, role: "HOD", status: "PENDING" },
        { sequence: 1, role: "STUDENT", status: "SIGNED" },
        { sequence: 2, role: "FACULTY_ADVISOR", status: "ACTIVE" },
      ]).map(({ role, state }) => [role, state]),
    ).toEqual([
      ["STUDENT", "complete"],
      ["FACULTY_ADVISOR", "active"],
      ["HOD", "pending"],
    ]);
  });

  it("explains configured completeness gaps without adding institutional rules", () => {
    expect(
      checkRequestCompleteness(
        {
          purpose: "",
          dateStart: "2026-10-14",
          dateEnd: "2026-10-13",
          destinationOrEvent: "",
          supportingInformation: "",
        },
        rules,
      ),
    ).toEqual([
      "Purpose may be missing.",
      "Destination or event may be missing.",
      "Supporting information may be missing.",
      "The start date is after the end date.",
    ]);
  });

  it("recognizes a complete request using the configured example fields", () => {
    expect(
      checkRequestCompleteness(
        {
          purpose: "Present a research poster",
          dateStart: "2026-11-01",
          dateEnd: "2026-11-03",
          destinationOrEvent: "Student research symposium",
          supportingInformation: "Accepted abstract attached",
        },
        rules,
      ),
    ).toEqual([]);
  });

  it("routes successful draft creation and surfaces upload failures", () => {
    expect(
      documentCreationOutcome(true, { documentId: "new-document" }),
    ).toEqual({
      destination: "/documents/new-document",
    });
    expect(
      documentCreationOutcome(false, {
        error: { message: "The PDF exceeds the page limit." },
      }),
    ).toEqual({ error: "The PDF exceeds the page limit." });
    expect(documentCreationOutcome(false, {})).toEqual({
      error: "Could not create the request",
    });
  });

  it("offers signing inputs only to the active current signer and preserves typed/drawn methods", () => {
    expect(
      canPresentSigningActions({
        isCurrent: false,
        signerStatus: "PENDING",
        documentStatus: "PENDING",
      }),
    ).toBe(false);
    expect(
      canPresentSigningActions({
        isCurrent: true,
        signerStatus: "ACTIVE",
        documentStatus: "COMPLETED",
      }),
    ).toBe(false);
    expect(
      canPresentSigningActions({
        isCurrent: true,
        signerStatus: "ACTIVE",
        documentStatus: "PENDING",
      }),
    ).toBe(true);
    expect(signatureSubmission("TYPED", "  Jordan Lee  ")).toEqual({
      method: "TYPED",
      value: "Jordan Lee",
    });
    expect(signatureSubmission("DRAWN", "data:image/png;base64,abc=")).toEqual({
      method: "DRAWN",
      value: "data:image/png;base64,abc=",
    });
    expect(signatureSubmission("DRAWN", undefined)).toBeNull();
  });

  it("hides document previews after an integrity failure or cancellation", () => {
    expect(canShowDocumentPreview("COMPLETED")).toBe(true);
    expect(canShowDocumentPreview("PENDING")).toBe(true);
    expect(canShowDocumentPreview("INTEGRITY_FAILED")).toBe(false);
    expect(canShowDocumentPreview("CANCELLED")).toBe(false);
  });
});
