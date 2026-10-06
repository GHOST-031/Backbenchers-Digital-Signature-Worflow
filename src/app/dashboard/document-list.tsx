"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { documentStatusLabel, type DocumentStatus } from "../ui-models";

export type DashboardDocument = {
  id: string;
  title: string;
  letter_type: "OD" | "PERMISSION";
  status: DocumentStatus;
  created_at: string | Date;
  completed_at: string | Date | null;
  signer_count: number | string;
  field_count: number | string;
  active_role: "STUDENT" | "FACULTY_ADVISOR" | "HOD" | null;
  signed_count: number | string;
};

const roleLabels: Record<string, string> = {
  STUDENT: "Student",
  FACULTY_ADVISOR: "Faculty Advisor",
  HOD: "HoD",
};

export function DocumentList({
  documents,
}: {
  documents: DashboardDocument[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const filtered = useMemo(
    () =>
      documents.filter((document) => {
        const matchesQuery = `${document.title} ${document.letter_type}`
          .toLowerCase()
          .includes(query.toLowerCase());
        return matchesQuery && (filter === "ALL" || document.status === filter);
      }),
    [documents, filter, query],
  );
  if (!documents.length)
    return (
      <div className="empty-state">
        <div className="empty-icon" aria-hidden="true">
          ✎
        </div>
        <p className="eyebrow">A clear start</p>
        <h2>No requests yet</h2>
        <p>
          Create an OD or permission request to begin the Student → Faculty
          Advisor → HoD workflow.
        </p>
        <Link className="button" href="/documents/new">
          Create your first request
        </Link>
      </div>
    );
  const statuses = [
    "ALL",
    "DRAFT",
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "INTEGRITY_FAILED",
    "CANCELLED",
  ];
  return (
    <>
      <div className="dashboard-tools">
        <label className="search-control">
          <span className="sr-only">Search documents</span>
          <span aria-hidden="true">⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documents"
          />
        </label>
        <label className="filter-control">
          <span className="sr-only">Filter by status</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {status === "ALL"
                  ? "All statuses"
                  : documentStatusLabel(status as DocumentStatus)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted result-count">
          {filtered.length} {filtered.length === 1 ? "document" : "documents"}
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="state-card">
          <div>
            <h2>No matching documents</h2>
            <p>Try another search or status filter.</p>
          </div>
          <button
            className="text-button"
            onClick={() => {
              setQuery("");
              setFilter("ALL");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="document-grid">
          {filtered.map((document) => {
            const status = document.status as DocumentStatus;
            return (
              <Link
                className="document-card"
                href={`/documents/${document.id}`}
                key={document.id}
              >
                <div className="document-card-top">
                  <span
                    className={`status-pill status-${status.toLowerCase()}`}
                  >
                    {documentStatusLabel(status)}
                  </span>
                  <span className="document-type">
                    {document.letter_type === "OD" ? "On Duty" : "Permission"}
                  </span>
                </div>
                <h2>{document.title}</h2>
                <div
                  className="mini-progress"
                  aria-label={`${Number(document.signed_count)} of 3 signers completed`}
                >
                  {[0, 1, 2].map((index) => (
                    <span
                      className={
                        index < Number(document.signed_count) ? "done" : ""
                      }
                      key={index}
                    />
                  ))}
                </div>
                <div className="document-card-meta">
                  <span>
                    {document.status === "DRAFT"
                      ? `${Number(document.field_count)} fields · ${Number(document.signer_count)} signers`
                      : document.active_role
                        ? `Next: ${roleLabels[document.active_role]}`
                        : document.status === "COMPLETED"
                          ? "Sealed final document"
                          : document.status === "INTEGRITY_FAILED"
                            ? "Integrity review required"
                            : "Workflow update in progress"}
                  </span>
                  <time dateTime={new Date(document.created_at).toISOString()}>
                    Created {new Date(document.created_at).toLocaleDateString()}
                  </time>
                </div>
                <span className="card-arrow" aria-hidden="true">
                  ↗
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
