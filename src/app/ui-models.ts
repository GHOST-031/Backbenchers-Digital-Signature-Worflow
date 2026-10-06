export type DocumentStatus =
  | "DRAFT"
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "INTEGRITY_FAILED"
  | "CANCELLED";

export function documentStatusLabel(status: DocumentStatus): string {
  const labels: Record<DocumentStatus, string> = {
    DRAFT: "Draft",
    PENDING: "In signing",
    PROCESSING: "Finalizing",
    COMPLETED: "Completed",
    INTEGRITY_FAILED: "Integrity failed",
    CANCELLED: "Cancelled",
  };
  return labels[status];
}

export type RequestDetails = {
  purpose: string;
  dateStart: string;
  dateEnd: string;
  destinationOrEvent: string;
  supportingInformation: string;
};

export type CompletenessRules = {
  label: string;
  requiredFields: string[];
  consistencyChecks: string[];
};

export function checkRequestCompleteness(
  details: RequestDetails,
  rules: CompletenessRules,
): string[] {
  const values: Record<string, string> = {
    purpose: details.purpose,
    dateRange: details.dateStart && details.dateEnd ? "complete" : "",
    destinationOrEvent: details.destinationOrEvent,
    supportingInformation: details.supportingInformation,
  };
  const titles: Record<string, string> = {
    purpose: "Purpose",
    dateRange: "Date range",
    destinationOrEvent: "Destination or event",
    supportingInformation: "Supporting information",
  };
  const messages = rules.requiredFields
    .filter((field) => !values[field]?.trim())
    .map((field) => `${titles[field] ?? field} may be missing.`);
  if (
    rules.consistencyChecks.includes(
      "dateRange.start must not be after dateRange.end",
    ) &&
    details.dateStart &&
    details.dateEnd &&
    details.dateStart > details.dateEnd
  ) {
    messages.push("The start date is after the end date.");
  }
  return messages;
}

export type SignerProgressItem = {
  sequence: number;
  role: string;
  status: string;
  id?: string;
  email?: string;
};

export function signerProgress(signers: SignerProgressItem[]) {
  return [...signers]
    .sort((a, b) => a.sequence - b.sequence)
    .map(
      (signer) =>
        ({
          ...signer,
          state:
            signer.status === "SIGNED"
              ? "complete"
              : signer.status === "ACTIVE"
                ? "active"
                : "pending",
        }) as const,
    );
}

export function documentCreationOutcome(
  responseOk: boolean,
  result: { documentId?: string; error?: { message?: string } },
) {
  if (responseOk && result.documentId)
    return { destination: `/documents/${result.documentId}` };
  return {
    error: responseOk
      ? "The request was created but its document page could not be opened."
      : (result.error?.message ?? "Could not create the request"),
  };
}

export function canPresentSigningActions(input: {
  isCurrent: boolean;
  signerStatus: string;
  documentStatus: string;
}) {
  return (
    input.isCurrent &&
    input.signerStatus === "ACTIVE" &&
    input.documentStatus === "PENDING"
  );
}

export function signatureSubmission(
  method: "TYPED" | "DRAWN",
  value: string | undefined,
) {
  const normalized = method === "TYPED" ? value?.trim() : value;
  return normalized ? { method, value: normalized } : null;
}

export function canShowDocumentPreview(status: string) {
  return status !== "INTEGRITY_FAILED" && status !== "CANCELLED";
}
