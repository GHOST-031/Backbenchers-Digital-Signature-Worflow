"use client";

import * as pdfjs from "pdfjs-dist";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { AuditHistory } from "./audit-history";
import { CompletenessAssistant } from "./completeness-assistant";
import {
  canShowDocumentPreview,
  documentStatusLabel,
  signerProgress,
} from "@/app/ui-models";

pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";

type DocumentRecord = {
  id: string;
  title: string;
  letterType: string;
  status: string;
  createdAt?: string;
  source: { pageCount: number; viewPath: string } | null;
  signers: Array<{
    id: string;
    sequence: number;
    role: "STUDENT" | "FACULTY_ADVISOR" | "HOD";
    email: string;
    status: string;
  }>;
  fields: Array<FieldRecord>;
  readinessIssues: string[];
};
type FieldRecord = {
  id?: string;
  signer_id?: string;
  signerId?: string;
  page_number?: number;
  pageNumber?: number;
  x: number | string;
  y: number | string;
  width: number | string;
  height: number | string;
  field_type?: string;
  fieldType?: string;
  required: boolean;
};
type LocalField = {
  id?: string;
  signerId: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: "SIGNATURE";
  required: boolean;
};

const roles = ["STUDENT", "FACULTY_ADVISOR", "HOD"] as const;
const roleLabels: Record<string, string> = {
  STUDENT: "Student",
  FACULTY_ADVISOR: "Faculty Advisor",
  HOD: "HoD",
};

export function DocumentEditor({ documentId }: { documentId: string }) {
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [fields, setFields] = useState<LocalField[]>([]);
  const [emails, setEmails] = useState(["", "", ""]);
  const [selectedSigner, setSelectedSigner] = useState("");
  const [selectedFieldIndex, setSelectedFieldIndex] = useState<number | null>(
    null,
  );
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageNumbers, setPageNumbers] = useState<number[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/documents/${documentId}`, {
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not load request");
      const value = result.document as DocumentRecord;
      setDocument(value);
      if (!canShowDocumentPreview(value.status)) {
        setPdf(null);
        setPageNumbers([]);
      }
      setFields(
        value.fields.map((field) => ({
          id: field.id,
          signerId: field.signer_id ?? field.signerId ?? "",
          pageNumber: Number(field.page_number ?? field.pageNumber),
          x: Number(field.x),
          y: Number(field.y),
          width: Number(field.width),
          height: Number(field.height),
          fieldType: "SIGNATURE",
          required: field.required,
        })),
      );
      setEmails(
        roles.map(
          (role) =>
            value.signers.find((signer) => signer.role === role)?.email ?? "",
        ),
      );
      setSelectedSigner((current) =>
        value.signers.some((signer) => signer.id === current)
          ? current
          : (value.signers[0]?.id ?? ""),
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load request",
      );
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let disposed = false;
    let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;
    async function openPdf() {
      if (!document?.source || !canShowDocumentPreview(document.status)) return;
      try {
        const response = await fetch(document.source.viewPath, {
          cache: "no-store",
        });
        if (!response.ok) {
          const result = await response.json().catch(() => null);
          if (result?.error?.code === "INTEGRITY_FAILED") {
            await load();
            setError(
              "The final PDF failed integrity verification and is unavailable.",
            );
            return;
          }
          throw new Error(result.error?.message ?? "Could not open PDF");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        loadingTask = pdfjs.getDocument({ data: bytes });
        const loaded = await loadingTask.promise;
        if (disposed) {
          await loadingTask.destroy();
          return;
        }
        setPdf(loaded);
        setPageNumbers(
          Array.from({ length: loaded.numPages }, (_, index) => index + 1),
        );
      } catch (cause) {
        if (!disposed)
          setError(
            cause instanceof Error ? cause.message : "Could not open PDF",
          );
      }
    }
    void openPdf();
    return () => {
      disposed = true;
      if (loadingTask) void loadingTask.destroy();
      setPdf(null);
    };
  }, [document?.source?.viewPath, document?.status, load]);

  const signerOptions = useMemo(
    () =>
      [...(document?.signers ?? [])].sort((a, b) => a.sequence - b.sequence),
    [document?.signers],
  );

  async function saveSigners() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/documents/${documentId}/signers`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signers: roles.map((role, index) => ({
            sequence: index + 1,
            role,
            email: emails[index],
          })),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not save signers");
      setNotice("Signer assignments saved.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save signers",
      );
    } finally {
      setBusy(false);
    }
  }

  function placeField(event: MouseEvent<HTMLDivElement>, pageNumber: number) {
    if (!selectedSigner) {
      setError(
        "Save all three signer assignments before placing signature fields.",
      );
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const width = 0.22;
    const height = 0.055;
    const x = Math.min(
      1 - width,
      Math.max(0, (event.clientX - bounds.left) / bounds.width - width / 2),
    );
    const y = Math.min(
      1 - height,
      Math.max(0, (event.clientY - bounds.top) / bounds.height - height / 2),
    );
    setFields((current) => [
      ...current,
      {
        signerId: selectedSigner,
        pageNumber,
        x: Math.round(x * 10_000_000) / 10_000_000,
        y: Math.round(y * 10_000_000) / 10_000_000,
        width,
        height,
        fieldType: "SIGNATURE",
        required: true,
      },
    ]);
    setSelectedFieldIndex(fields.length);
    setError("");
  }

  async function saveFields() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/documents/${documentId}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not save fields");
      setNotice("Signature fields saved.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save fields",
      );
    } finally {
      setBusy(false);
    }
  }

  async function sendForSigning() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/documents/${documentId}/send`, {
        method: "POST",
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not start signing");
      setNotice("Signing started. The Student is the current signer.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start signing",
      );
    } finally {
      setBusy(false);
    }
  }

  async function downloadFinalPdf() {
    setDownloadBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/documents/${documentId}/source`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null);
        if (result?.error?.code === "INTEGRITY_FAILED") {
          await load();
          setError(
            "The final PDF failed integrity verification and is unavailable.",
          );
          return;
        }
        throw new Error(
          result?.error?.message ?? "Could not retrieve the final PDF",
        );
      }
      const url = URL.createObjectURL(await response.blob());
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${document?.title || "completed-document"}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not retrieve the final PDF",
      );
    } finally {
      setDownloadBusy(false);
    }
  }

  async function deleteField(field: LocalField) {
    setSelectedFieldIndex(null);
    if (!field.id) {
      setFields((current) =>
        current.filter((candidate) => candidate !== field),
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/documents/${documentId}/fields/${field.id}`,
        { method: "DELETE" },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not delete field");
      setFields((current) =>
        current.filter((candidate) => candidate.id !== field.id),
      );
      setNotice("Signature field deleted.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not delete field",
      );
    } finally {
      setBusy(false);
    }
  }

  function adjustSelectedField(
    change: Partial<Pick<LocalField, "x" | "y" | "width" | "height">>,
  ) {
    if (selectedFieldIndex === null) return;
    setFields((current) =>
      current.map((field, index) => {
        if (index !== selectedFieldIndex) return field;
        const next = { ...field, ...change };
        next.width = Math.min(0.6, Math.max(0.04, next.width));
        next.height = Math.min(0.3, Math.max(0.025, next.height));
        next.x = Math.min(1 - next.width, Math.max(0, next.x));
        next.y = Math.min(1 - next.height, Math.max(0, next.y));
        return next;
      }),
    );
  }

  if (loading) return <p className="muted">Loading draft…</p>;
  if (!document)
    return (
      <p className="error" role="alert">
        {error || "Request not found"}
      </p>
    );
  return (
    <section className="editor page-wrap">
      <div className="detail-topline">
        <Link href="/dashboard" className="back-link">
          ← All documents
        </Link>
        <span className={`status-pill status-${document.status.toLowerCase()}`}>
          {documentStatusLabel(
            document.status as Parameters<typeof documentStatusLabel>[0],
          )}
        </span>
      </div>
      <div className="detail-title-row">
        <div>
          <p className="eyebrow">
            {document.letterType === "OD"
              ? "On Duty request"
              : "Permission request"}
          </p>
          <h1>{document.title}</h1>
          <p className="muted">
            Created{" "}
            {document.createdAt
              ? new Date(document.createdAt).toLocaleDateString()
              : "date unavailable"}
            {document.source
              ? ` · ${document.source.pageCount} page${document.source.pageCount === 1 ? "" : "s"}`
              : ""}
            {" · Request ID "}
            <span className="mono">{document.id}</span>
          </p>
        </div>
        {document.status === "COMPLETED" && (
          <button
            className="button"
            type="button"
            disabled={downloadBusy}
            onClick={() => void downloadFinalPdf()}
          >
            {downloadBusy
              ? "Verifying final PDF…"
              : "Download verified final PDF"}
          </button>
        )}
      </div>

      <section className="workflow-panel card editor-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Signing route</p>
            <h2>Approval progress</h2>
          </div>
          <span className="muted">The server controls who can act next.</span>
        </div>
        <ol className="progress-steps">
          {signerProgress(document.signers).map((signer) => (
            <li
              className={`progress-step progress-${signer.state}`}
              key={signer.id ?? signer.sequence}
            >
              <span className="progress-number">
                {signer.state === "complete" ? "✓" : signer.sequence}
              </span>
              <div>
                <strong>{roleLabels[signer.role]}</strong>
                <span>{signer.email}</span>
                <small>
                  {signer.state === "complete"
                    ? "Completed"
                    : signer.state === "active"
                      ? "Action required"
                      : "Waiting"}
                </small>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {document.status === "DRAFT" ? (
        <>
          <section className="card editor-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>Assign signers</h2>
              </div>
              <span className="muted">
                Each email must belong to an application account.
              </span>
            </div>
            <div className="signer-grid">
              {roles.map((role, index) => {
                const assigned = document.signers.find(
                  (signer) => signer.role === role,
                );
                return (
                  <label key={role}>
                    <span>
                      {index + 1}. {roleLabels[role]}
                    </span>
                    <input
                      type="email"
                      required
                      value={emails[index]}
                      onChange={(event) =>
                        setEmails((current) =>
                          current.map((email, i) =>
                            i === index ? event.target.value : email,
                          ),
                        )
                      }
                      placeholder="signer@example.edu"
                    />
                    {assigned && (
                      <small className="muted">State: {assigned.status}</small>
                    )}
                  </label>
                );
              })}
            </div>
            <button
              className="button secondary"
              disabled={busy}
              onClick={saveSigners}
            >
              Save signer assignments
            </button>
          </section>

          {document.signers.length === 3 && (
            <section className="card editor-card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Step 2</p>
                  <h2>Place signature fields</h2>
                </div>
                <p className="muted">
                  Choose a signer, then click a page to place a required field.
                </p>
              </div>
              <label className="signer-picker">
                Field owner
                <select
                  value={selectedSigner}
                  onChange={(event) => setSelectedSigner(event.target.value)}
                >
                  {signerOptions.map((signer) => (
                    <option key={signer.id} value={signer.id}>
                      {roleLabels[signer.role]} · {signer.email}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                Selected field owner:{" "}
                {roleLabels[
                  signerOptions.find((signer) => signer.id === selectedSigner)
                    ?.role ?? ""
                ] ?? "Choose signer"}
              </p>
              {pdf ? (
                <div className="pdf-pages">
                  {pageNumbers.map((pageNumber) => (
                    <PdfPage
                      key={pageNumber}
                      pdf={pdf}
                      pageNumber={pageNumber}
                      fields={fields.filter(
                        (field) => field.pageNumber === pageNumber,
                      )}
                      fieldIndexes={fields
                        .map((field, index) =>
                          field.pageNumber === pageNumber ? index : -1,
                        )
                        .filter((index) => index >= 0)}
                      signers={signerOptions}
                      onPlace={placeField}
                      onSelect={(field) =>
                        setSelectedFieldIndex(fields.indexOf(field))
                      }
                      selectedFieldIndex={selectedFieldIndex}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">Loading private PDF preview…</p>
              )}
              {selectedFieldIndex !== null && fields[selectedFieldIndex] && (
                <div
                  className="field-controls"
                  aria-label="Selected signature field controls"
                >
                  <div>
                    <strong>Selected field</strong>
                    <span className="muted">
                      Move or adjust its size. Changes apply after saving
                      fields.
                    </span>
                  </div>
                  <div className="field-control-grid">
                    <button
                      type="button"
                      className="button secondary"
                      aria-label="Move field left"
                      onClick={() =>
                        adjustSelectedField({
                          x: fields[selectedFieldIndex].x - 0.01,
                        })
                      }
                    >
                      ← Move
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label="Move field up"
                      onClick={() =>
                        adjustSelectedField({
                          y: fields[selectedFieldIndex].y - 0.01,
                        })
                      }
                    >
                      ↑ Move
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label="Move field down"
                      onClick={() =>
                        adjustSelectedField({
                          y: fields[selectedFieldIndex].y + 0.01,
                        })
                      }
                    >
                      ↓ Move
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      aria-label="Move field right"
                      onClick={() =>
                        adjustSelectedField({
                          x: fields[selectedFieldIndex].x + 0.01,
                        })
                      }
                    >
                      Move →
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        adjustSelectedField({
                          width: fields[selectedFieldIndex].width - 0.01,
                        })
                      }
                    >
                      − Width
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        adjustSelectedField({
                          width: fields[selectedFieldIndex].width + 0.01,
                        })
                      }
                    >
                      + Width
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        adjustSelectedField({
                          height: fields[selectedFieldIndex].height - 0.01,
                        })
                      }
                    >
                      − Height
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() =>
                        adjustSelectedField({
                          height: fields[selectedFieldIndex].height + 0.01,
                        })
                      }
                    >
                      + Height
                    </button>
                    <button
                      type="button"
                      className="button danger-button"
                      onClick={() =>
                        void deleteField(fields[selectedFieldIndex])
                      }
                    >
                      Remove field
                    </button>
                  </div>
                </div>
              )}
              <button
                className="button"
                disabled={busy || !pdf}
                onClick={saveFields}
              >
                {busy ? "Saving…" : "Save signature fields"}
              </button>
            </section>
          )}

          {document.status === "DRAFT" && (
            <CompletenessAssistant documentId={documentId} />
          )}

          <section
            className={`readiness ${document.readinessIssues.length ? "not-ready" : "ready"}`}
          >
            <p className="eyebrow">
              {document.status === "DRAFT" ? "Draft status" : "Workflow status"}
            </p>
            <h2>
              {document.readinessIssues.length
                ? "Setup in progress"
                : "Ready to send"}
            </h2>
            {document.readinessIssues.length > 0 ? (
              <ul>
                {document.readinessIssues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p>
                {document.status === "DRAFT"
                  ? "All required signers and signature fields are configured."
                  : "This document is in the signing workflow."}
              </p>
            )}
            {!document.readinessIssues.length &&
              document.status === "DRAFT" && (
                <button
                  className="button"
                  disabled={busy}
                  onClick={sendForSigning}
                >
                  {busy ? "Starting…" : "Send for signing"}
                </button>
              )}
          </section>
          {notice && (
            <p className="success" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </>
      ) : (
        <section className="card editor-card locked-notice">
          <p className="eyebrow">
            {document.status === "COMPLETED"
              ? "Workflow complete"
              : "Read-only request"}
          </p>
          <h2>
            {document.status === "COMPLETED"
              ? "All signatures are complete"
              : "Preparation is closed"}
          </h2>
          <p className="muted">
            Document configuration is locked after the signing workflow begins.
          </p>
          {document.source && canShowDocumentPreview(document.status) && (
            <iframe
              className="document-preview"
              title={
                document.status === "COMPLETED"
                  ? "Verified final PDF"
                  : "Document PDF preview"
              }
              src={document.source.viewPath}
            />
          )}
          {document.status === "COMPLETED" && (
            <div className="integrity-banner">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>Final PDF is sealed</strong>
                <p>
                  Integrity is checked by the server whenever the final PDF is
                  retrieved.
                </p>
              </div>
            </div>
          )}
          {document.status === "INTEGRITY_FAILED" && (
            <div className="integrity-banner integrity-error" role="alert">
              <span aria-hidden="true">!</span>
              <div>
                <strong>This final document could not be verified</strong>
                <p>
                  The PDF is unavailable while the integrity issue is reviewed.
                  No document file is shown here.
                </p>
              </div>
            </div>
          )}
        </section>
      )}
      <AuditHistory
        documentId={documentId}
        signerRoles={Object.fromEntries(
          document.signers.map((signer) => [
            signer.id,
            roleLabels[signer.role],
          ]),
        )}
      />
    </section>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  fields,
  fieldIndexes,
  signers,
  onPlace,
  onSelect,
  selectedFieldIndex,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  fields: LocalField[];
  fieldIndexes: number[];
  signers: DocumentRecord["signers"];
  onPlace: (event: MouseEvent<HTMLDivElement>, pageNumber: number) => void;
  onSelect: (field: LocalField) => void;
  selectedFieldIndex: number | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState("612 / 792");
  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void } | undefined;
    async function renderPage() {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.35 });
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      setRatio(`${viewport.width} / ${viewport.height}`);
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      try {
        await (renderTask as unknown as { promise: Promise<void> }).promise;
      } catch {
        /* unmounted render */
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber]);

  return (
    <article className="pdf-page">
      <div className="page-label">Page {pageNumber}</div>
      <div className="pdf-canvas-wrap" style={{ aspectRatio: ratio }}>
        <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
        <div
          className="pdf-placement-layer"
          onClick={(event) => onPlace(event, pageNumber)}
        >
          {fields.map((field, index) => {
            const globalIndex = fieldIndexes[index];
            const signer = signers.find(
              (candidate) => candidate.id === field.signerId,
            );
            return (
              <button
                className={`placed-field ${selectedFieldIndex === globalIndex ? "field-selected" : ""}`}
                key={
                  field.id ?? `${field.signerId}-${index}-${field.x}-${field.y}`
                }
                style={{
                  left: `${field.x * 100}%`,
                  top: `${field.y * 100}%`,
                  width: `${field.width * 100}%`,
                  height: `${field.height * 100}%`,
                }}
                title={`${signer ? roleLabels[signer.role] : "Signer"} signature field`}
                type="button"
                aria-label={`Select ${signer ? roleLabels[signer.role] : "signer"} signature field on page ${pageNumber}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(field);
                }}
              >
                {signer ? roleLabels[signer.role] : "Unassigned"} · field
              </button>
            );
          })}
        </div>
      </div>
      <p className="muted">
        Click the page to add a field. Select a field to move, resize or remove
        it.
      </p>
    </article>
  );
}
