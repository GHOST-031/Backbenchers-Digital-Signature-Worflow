"use client";

import { useEffect, useMemo, useState } from "react";
import rules from "@/config/od-rules.example.json";
import { checkRequestCompleteness, type RequestDetails } from "@/app/ui-models";

const emptyDetails: RequestDetails = {
  purpose: "",
  dateStart: "",
  dateEnd: "",
  destinationOrEvent: "",
  supportingInformation: "",
};

export function CompletenessAssistant({ documentId }: { documentId: string }) {
  const [details, setDetails] = useState(emptyDetails);
  const [loaded, setLoaded] = useState(false);
  const storageKey = `od-completeness:${documentId}`;
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved)
        setDetails({
          ...emptyDetails,
          ...(JSON.parse(saved) as Partial<RequestDetails>),
        });
    } catch {
      // The assistant is optional; unavailable browser storage leaves it empty.
    } finally {
      setLoaded(true);
    }
  }, [storageKey]);
  useEffect(() => {
    if (!loaded) return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(details));
    } catch {
      /* guidance remains usable for this visit */
    }
  }, [details, loaded, storageKey]);
  const messages = useMemo(
    () => checkRequestCompleteness(details, rules),
    [details],
  );
  function update(key: keyof RequestDetails, value: string) {
    setDetails((current) => ({ ...current, [key]: value }));
  }
  return (
    <section className="assistant-card" aria-labelledby="assistant-title">
      <div className="assistant-heading">
        <span className="assistant-icon" aria-hidden="true">
          ✦
        </span>
        <div>
          <p className="eyebrow">Request helper</p>
          <h2 id="assistant-title">Completeness assistant</h2>
        </div>
        <span className="advisory-tag">Guidance only</span>
      </div>
      <p className="muted">
        {rules.label}. These example checks are configurable guidance, not
        official university policy. Notes stay in this browser and are not added
        to the PDF or sent to signers.
      </p>
      <div className="assistant-fields">
        <label>
          Purpose
          <input
            value={details.purpose}
            onChange={(event) => update("purpose", event.target.value)}
            placeholder="Why is this request needed?"
          />
        </label>
        <fieldset className="date-range">
          <legend>Date or date range</legend>
          <label>
            From
            <input
              type="date"
              value={details.dateStart}
              onChange={(event) => update("dateStart", event.target.value)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={details.dateEnd}
              onChange={(event) => update("dateEnd", event.target.value)}
            />
          </label>
        </fieldset>
        <label>
          Destination or event
          <input
            value={details.destinationOrEvent}
            onChange={(event) =>
              update("destinationOrEvent", event.target.value)
            }
            placeholder="Where are you going?"
          />
        </label>
        <label>
          Supporting information
          <textarea
            value={details.supportingInformation}
            onChange={(event) =>
              update("supportingInformation", event.target.value)
            }
            rows={3}
            placeholder="Add useful context for reviewers"
          />
        </label>
      </div>
      <div
        className={`assistant-result ${messages.length ? "assistant-incomplete" : "assistant-complete"}`}
        aria-live="polite"
      >
        {messages.length ? (
          <>
            <strong>Things you may want to add</strong>
            <ul>
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </>
        ) : (
          <strong>These example checks look complete.</strong>
        )}
      </div>
      <p className="assistant-footnote">
        This helper does not block sending. The server’s document readiness
        rules determine whether the workflow can start.
      </p>
    </section>
  );
}
