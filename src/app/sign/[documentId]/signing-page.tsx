"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { SigningPdf } from "./signing-pdf";
import { canPresentSigningActions, signatureSubmission } from "@/app/ui-models";

type SignContext = {
  id: string;
  title: string;
  status: string;
  signer_id: string;
  role: string;
  sequence: number;
  signer_status: string;
  is_current: boolean;
  workflow_signers: Array<{ sequence: number; role: string; status: string }>;
  fields: Array<{
    id: string;
    pageNumber: number;
    x: number | string;
    y: number | string;
    width: number | string;
    height: number | string;
    fieldType: string;
    required: boolean;
    signedAt: string | null;
  }>;
};
const labels: Record<string, string> = {
  STUDENT: "Student",
  FACULTY_ADVISOR: "Faculty Advisor",
  HOD: "HoD",
};

export function SigningPage({ documentId }: { documentId: string }) {
  const [context, setContext] = useState<SignContext | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [selected, setSelected] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const load = useCallback(async () => {
    const response = await fetch(`/api/sign/${documentId}`, {
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error?.message ?? "Could not load signing page");
    setContext(result.context as SignContext);
  }, [documentId]);
  useEffect(() => {
    void load().catch((cause) =>
      setError(
        cause instanceof Error ? cause.message : "Could not load signing page",
      ),
    );
  }, [load]);
  function draw(event: PointerEvent<HTMLCanvasElement>) {
    const surface = canvas.current;
    const context = surface?.getContext("2d");
    if (!surface || !context) return;
    const box = surface.getBoundingClientRect();
    const x = ((event.clientX - box.left) * surface.width) / box.width;
    const y = ((event.clientY - box.top) * surface.height) / box.height;
    if (event.type === "pointerdown") {
      drawing.current = true;
      surface.setPointerCapture(event.pointerId);
      context.beginPath();
      context.moveTo(x, y);
    } else if (drawing.current) {
      context.lineWidth = 3;
      context.lineCap = "round";
      context.strokeStyle = "#142f50";
      context.lineTo(x, y);
      context.stroke();
      setHasDrawing(true);
    }
    if (event.type === "pointerup" || event.type === "pointercancel")
      drawing.current = false;
  }
  async function sign(method: "TYPED" | "DRAWN") {
    if (!selected) return setError("Choose one of your signature fields.");
    const submission = signatureSubmission(
      method,
      method === "TYPED"
        ? typed
        : hasDrawing
          ? canvas.current?.toDataURL("image/png")
          : undefined,
    );
    if (!submission) return setError("Provide a signature first.");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        `/api/sign/${documentId}/fields/${selected}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requestId: crypto.randomUUID(),
            ...submission,
          }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not save signature");
      setNotice("Signature saved.");
      setSelected("");
      setTyped("");
      if (canvas.current)
        canvas.current
          .getContext("2d")
          ?.clearRect(0, 0, canvas.current.width, canvas.current.height);
      setHasDrawing(false);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save signature",
      );
    } finally {
      setBusy(false);
    }
  }
  async function complete() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/sign/${documentId}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: crypto.randomUUID() }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not complete signing");
      setNotice(
        result.readyForSealing
          ? "All three signers have completed. The final PDF is being prepared."
          : "Your step is complete. The next signer is now eligible.",
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not complete signing",
      );
    } finally {
      setBusy(false);
    }
  }
  if (error && !context)
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  if (!context) return <p className="muted">Loading signing page…</p>;
  const fields = context.fields;
  const signingAllowed = canPresentSigningActions({
    isCurrent: context.is_current,
    signerStatus: context.signer_status,
    documentStatus: context.status,
  });
  const requiredComplete = fields
    .filter((field) => field.required)
    .every((field) => field.signedAt);
  return (
    <section className="editor page-wrap signing-layout">
      <div className="page-heading">
        <div>
          <p className="eyebrow">
            Signer workspace · step {context.sequence} of 3
          </p>
          <h1>{context.title}</h1>
          <p className="muted">
            You are signing as <strong>{labels[context.role]}</strong>.
          </p>
        </div>
        <span
          className={`status-pill ${context.is_current ? "status-pending" : "status-draft"}`}
        >
          {context.is_current
            ? "Your action is next"
            : context.signer_status === "SIGNED"
              ? "Step completed"
              : "Waiting"}
        </span>
      </div>
      <ol className="progress-steps signer-progress">
        {context.workflow_signers.map((signer) => (
          <li
            className={`progress-step progress-${signer.status === "SIGNED" ? "complete" : signer.status === "ACTIVE" ? "active" : "pending"}`}
            key={signer.sequence}
          >
            <span className="progress-number">
              {signer.status === "SIGNED" ? "✓" : signer.sequence}
            </span>
            <div>
              <strong>{labels[signer.role]}</strong>
              <small>
                {signer.status === "SIGNED"
                  ? "Completed"
                  : signer.status === "ACTIVE"
                    ? "Signing now"
                    : "Waiting"}
              </small>
            </div>
          </li>
        ))}
      </ol>
      {!context.is_current ? (
        <div className="card">
          <h2>Waiting for your turn</h2>
          <p>
            Signing proceeds Student → Faculty Advisor → HoD. You can review the
            document, but signing is available only when the previous signer
            completes.
          </p>
        </div>
      ) : null}
      {context.status === "INTEGRITY_FAILED" ? (
        <div className="integrity-banner integrity-error" role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <strong>Document integrity check failed</strong>
            <p>The document is unavailable and cannot be signed.</p>
          </div>
        </div>
      ) : (
        <div className="card editor-card signing-workspace">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your assigned fields</p>
              <h2>Review and sign</h2>
            </div>
            <span className="muted">
              Required fields:{" "}
              {
                fields
                  .filter((field) => field.required)
                  .filter((field) => !field.signedAt).length
              }{" "}
              remaining
            </span>
          </div>
          <SigningPdf
            documentId={documentId}
            fields={fields}
            onSelect={(id) => {
              setSelected(id);
              setError("");
            }}
          />
          {fields.length === 0 ? (
            <p className="muted">No signature fields are assigned to you.</p>
          ) : (
            <ul className="signing-field-list">
              {fields.map((field) => (
                <li key={field.id}>
                  Page {field.pageNumber} ·{" "}
                  {field.required ? "Required" : "Optional"} ·{" "}
                  {field.signedAt ? (
                    `Signed ${new Date(field.signedAt).toLocaleString()}`
                  ) : (
                    <button
                      type="button"
                      className="button secondary"
                      disabled={!signingAllowed || busy}
                      onClick={() => {
                        setSelected(field.id);
                        setError("");
                      }}
                    >
                      Sign this field
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {signingAllowed && selected && (
            <div className="signature-entry card">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">Signature input</p>
                  <h3>Choose a signature style</h3>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setSelected("")}
                >
                  Close
                </button>
              </div>
              <label>
                Typed signature
                <input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  maxLength={200}
                />
              </label>
              <button
                className="button secondary"
                disabled={busy || !typed.trim()}
                onClick={() => void sign("TYPED")}
              >
                Save typed signature
              </button>
              <p>Or draw your signature:</p>
              <canvas
                ref={canvas}
                width={600}
                height={180}
                style={{
                  width: "100%",
                  maxWidth: 600,
                  border: "1px solid #aab4c2",
                  touchAction: "none",
                }}
                onPointerDown={(event) => draw(event)}
                onPointerMove={(event) => draw(event)}
                onPointerUp={(event) => draw(event)}
                onPointerCancel={(event) => draw(event)}
                aria-label="Draw signature"
              />
              <div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => (
                    canvas.current?.getContext("2d")?.clearRect(0, 0, 600, 180),
                    setHasDrawing(false)
                  )}
                >
                  Clear drawing
                </button>{" "}
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => void sign("DRAWN")}
                >
                  Save drawn signature
                </button>
              </div>
            </div>
          )}
          {signingAllowed && (
            <button
              className="button"
              disabled={busy || !requiredComplete}
              onClick={() => void complete()}
            >
              Complete signing
            </button>
          )}
        </div>
      )}
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
    </section>
  );
}
