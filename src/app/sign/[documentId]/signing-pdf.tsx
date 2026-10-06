"use client";

import * as pdfjs from "pdfjs-dist";
import { useEffect, useState } from "react";

pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";

type Field = {
  id: string;
  pageNumber: number;
  x: number | string;
  y: number | string;
  width: number | string;
  height: number | string;
  required: boolean;
  signedAt: string | null;
};

export function SigningPdf({
  documentId,
  fields,
  onSelect,
}: {
  documentId: string;
  fields: Field[];
  onSelect: (fieldId: string) => void;
}) {
  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<number[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    fetch(`/api/documents/${documentId}/source`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("The document preview is unavailable.");
        const bytes = new Uint8Array(await response.arrayBuffer());
        task = pdfjs.getDocument({ data: bytes });
        return task.promise;
      })
      .then((document) => {
        if (cancelled) {
          void task?.destroy();
          return;
        }
        setPdf(document);
        setPages(
          Array.from({ length: document.numPages }, (_, index) => index + 1),
        );
      })
      .catch((cause) => {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Could not open PDF",
          );
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [documentId]);
  if (error)
    return (
      <div className="inline-alert" role="alert">
        {error}
      </div>
    );
  if (!pdf) return <p className="muted">Opening secure document preview…</p>;
  return (
    <div className="signing-pdf-pages">
      {pages.map((pageNumber) => (
        <SigningPdfPage
          key={pageNumber}
          pdf={pdf}
          pageNumber={pageNumber}
          fields={fields.filter((field) => field.pageNumber === pageNumber)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function SigningPdfPage({
  pdf,
  pageNumber,
  fields,
  onSelect,
}: {
  pdf: pdfjs.PDFDocumentProxy;
  pageNumber: number;
  fields: Field[];
  onSelect: (id: string) => void;
}) {
  const [ratio, setRatio] = useState("612 / 792");
  useEffect(() => {
    let cancelled = false;
    let render: ReturnType<pdfjs.PDFPageProxy["render"]> | undefined;
    const canvas = document.querySelector<HTMLCanvasElement>(
      `[data-sign-page="${pageNumber}"]`,
    );
    async function paint() {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.25 });
      if (cancelled || !canvas) return;
      const context = canvas.getContext("2d");
      if (!context) return;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      setRatio(`${viewport.width} / ${viewport.height}`);
      render = page.render({ canvas, canvasContext: context, viewport });
      try {
        await render.promise;
      } catch {
        /* cancelled during navigation */
      }
    }
    void paint();
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, pageNumber]);
  return (
    <article className="signing-pdf-page">
      <p className="page-label">Page {pageNumber}</p>
      <div className="signing-page-canvas" style={{ aspectRatio: ratio }}>
        <canvas
          data-sign-page={pageNumber}
          aria-label={`Document page ${pageNumber}`}
        />
        {fields.map((field) => (
          <button
            key={field.id}
            className={`signing-field-marker ${field.signedAt ? "field-done" : ""}`}
            style={{
              left: `${Number(field.x) * 100}%`,
              top: `${Number(field.y) * 100}%`,
              width: `${Number(field.width) * 100}%`,
              height: `${Number(field.height) * 100}%`,
            }}
            onClick={() => onSelect(field.id)}
            aria-label={`${field.required ? "Required" : "Optional"} signature field on page ${pageNumber}${field.signedAt ? ", completed" : ""}`}
          >
            {field.signedAt ? "Signed" : "Your signature"}
          </button>
        ))}
      </div>
    </article>
  );
}
