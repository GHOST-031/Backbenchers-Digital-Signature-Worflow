"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { documentCreationOutcome } from "@/app/ui-models";

export function NewDocumentForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const [fileHint, setFileHint] = useState(
    "PDF only · up to 10 MB · up to 50 pages",
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) {
        setError("Choose a PDF file to continue.");
        return;
      }
      if (
        file.type !== "application/pdf" &&
        !file.name.toLowerCase().endsWith(".pdf")
      ) {
        setError("Choose a PDF file. Other file types are not supported.");
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError("This file is larger than the 10 MB upload limit.");
        return;
      }
      const response = await fetch("/api/documents", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      const outcome = documentCreationOutcome(response.ok, result);
      if (outcome.error) {
        setError(outcome.error);
        return;
      }
      if (outcome.destination) router.push(outcome.destination);
    } catch {
      setError(
        "The request could not be sent. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card document-form" onSubmit={submit}>
      <label>
        Request type
        <select name="letterType" defaultValue="OD" required>
          <option value="OD">On Duty (OD)</option>
          <option value="PERMISSION">Permission letter</option>
        </select>
      </label>
      <label>
        Document title
        <input
          name="title"
          maxLength={200}
          required
          placeholder="For example, Inter-college conference"
        />
      </label>
      <label>
        PDF file
        <input
          name="file"
          type="file"
          accept="application/pdf,.pdf"
          required
          onChange={(event) => {
            const file = event.target.files?.[0];
            setFileName(file?.name ?? "");
            setError("");
            if (file && file.size > 10 * 1024 * 1024)
              setFileHint("This file exceeds the 10 MB limit.");
            else
              setFileHint(
                file
                  ? `${(file.size / (1024 * 1024)).toFixed(2)} MB selected · page limit checked during upload`
                  : "PDF only · up to 10 MB · up to 50 pages",
              );
          }}
        />
        <span className="muted">
          {fileName ? `${fileName} · ` : ""}
          {fileHint}
        </span>
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="button" disabled={busy}>
          {busy ? "Uploading and validating…" : "Create draft"}
        </button>
      </div>
    </form>
  );
}
