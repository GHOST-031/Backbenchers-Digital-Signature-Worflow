"use client";

import { useEffect, useState } from "react";

export type AuditEvent = {
  id: string;
  sequence: string;
  actorType: string;
  actorUserId: string | null;
  actorSignerId: string | null;
  eventType: string;
  occurredAt: string;
  details: Record<string, unknown>;
};

const eventLabels: Record<string, string> = {
  DOCUMENT_CREATED: "Request created",
  DOCUMENT_VIEWED: "Document viewed",
  DOCUMENT_UPLOADED: "PDF uploaded",
  DOCUMENT_VERSION_CREATED: "PDF version created",
  SIGNER_ASSIGNED: "Signer assigned",
  SIGNER_CONFIGURATION_UPDATED: "Signer assignments updated",
  SIGNATURE_FIELD_CREATED: "Signature field placed",
  SIGNATURE_FIELD_UPDATED: "Signature field updated",
  SIGNATURE_FIELD_DELETED: "Signature field removed",
  FIELD_SIGNED: "Signature added",
  DOCUMENT_RECIPIENT_COMPLETED: "Signer completed their step",
  DOCUMENT_SEALED: "Final PDF sealed",
  INTEGRITY_VERIFIED: "Final PDF integrity verified",
  INTEGRITY_FAILED: "Integrity check failed",
};

export function AuditHistory({
  documentId,
  signerRoles = {},
}: {
  documentId: string;
  signerRoles?: Record<string, string>;
}) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrity, setIntegrity] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let active = true;
    fetch(`/api/documents/${documentId}/audit-events`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error?.message ?? "Could not load audit history",
          );
        if (!active) return;
        setEvents(result.events as AuditEvent[]);
        setIntegrity(result.integrity as string);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [documentId]);
  return (
    <section className="card editor-card audit-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Record</p>
          <h2>Audit history</h2>
        </div>
        {integrity === "VALID" && (
          <span className="verified-label">
            <span aria-hidden="true">✓</span> Verified by server
          </span>
        )}
      </div>
      {state === "loading" && (
        <p className="muted">Loading verified history…</p>
      )}
      {state === "error" && (
        <div className="inline-alert" role="alert">
          <strong>History unavailable or could not be verified.</strong>
          <p>
            The server did not confirm this audit chain. Reload to try again.
          </p>
          <button
            className="text-button"
            onClick={() => {
              setState("loading");
              setIntegrity(null);
              setEvents([]);
              fetch(`/api/documents/${documentId}/audit-events`, {
                cache: "no-store",
              })
                .then(async (response) => {
                  const result = await response.json();
                  if (!response.ok) throw new Error();
                  setEvents(result.events);
                  setIntegrity(result.integrity);
                  setState("ready");
                })
                .catch(() => setState("error"));
            }}
          >
            Retry
          </button>
        </div>
      )}
      {state === "ready" && (
        <VerifiedAuditTimeline
          events={events}
          integrity={integrity}
          signerRoles={signerRoles}
        />
      )}
      <p className="muted audit-caption">
        The server verifies the event sequence and integrity chain before
        returning this history.
      </p>
    </section>
  );
}

export function VerifiedAuditTimeline({
  events,
  integrity,
  signerRoles = {},
}: {
  events: AuditEvent[];
  integrity: string | null;
  signerRoles?: Record<string, string>;
}) {
  if (integrity !== "VALID")
    return (
      <p className="error" role="alert">
        Audit verification was not confirmed.
      </p>
    );
  if (events.length === 0)
    return <p className="muted">No activity has been recorded yet.</p>;
  return (
    <ol className="audit-list">
      {events.map((event) => (
        <li
          key={event.id}
          className={
            event.eventType === "INTEGRITY_FAILED" ? "audit-failure" : ""
          }
        >
          <span className="audit-dot" aria-hidden="true" />
          <div className="audit-event-main">
            <strong>
              {eventLabels[event.eventType] ??
                event.eventType.replaceAll("_", " ").toLowerCase()}
            </strong>
            <span className="muted">{actorLabel(event, signerRoles)}</span>
          </div>
          <time dateTime={event.occurredAt}>
            {new Date(event.occurredAt).toLocaleString()}
          </time>
        </li>
      ))}
    </ol>
  );
}

function actorLabel(event: AuditEvent, signerRoles: Record<string, string>) {
  if (event.actorType === "SYSTEM") return "System";
  if (event.actorType === "REQUESTER") return "Requester";
  if (event.actorSignerId && signerRoles[event.actorSignerId])
    return signerRoles[event.actorSignerId];
  return "Signer";
}
