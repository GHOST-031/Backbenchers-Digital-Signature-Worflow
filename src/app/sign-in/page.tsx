"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const account = {
      email: form.get("email"),
      password: form.get("password"),
    };
    try {
      if (mode === "register") {
        const created = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...account,
            displayName: form.get("displayName"),
          }),
        });
        const createdResult = await created.json();
        if (!created.ok)
          throw new Error(
            createdResult.error?.message ?? "Could not create account",
          );
      }
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(account),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Could not sign in");
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not continue");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-intro">
        <p className="eyebrow">Digital signature workflow</p>
        <h1>Approvals, in the right order.</h1>
        <p>
          Prepare an OD or permission request and follow its progress from the
          first signature through a verified final document.
        </p>
        <div className="auth-flow" aria-label="Signing sequence">
          <span>Student</span>
          <i aria-hidden="true">→</i>
          <span>Faculty Advisor</span>
          <i aria-hidden="true">→</i>
          <span>HoD</span>
        </div>
      </section>
      <section className="card auth-card">
        <p className="eyebrow">Local demo account</p>
        <h2>{mode === "signin" ? "Welcome back" : "Create an account"}</h2>
        <p className="muted">
          {mode === "signin"
            ? "Sign in to manage requests or complete an assigned signature."
            : "Application accounts are for this local/demo workflow. Institutional SSO is not configured."}
        </p>
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              Your name
              <input
                name="displayName"
                autoComplete="name"
                required
                maxLength={120}
              />
            </label>
          )}
          <label>
            Email
            <input required type="email" name="email" autoComplete="email" />
          </label>
          <label>
            Password
            <input
              required
              type="password"
              name="password"
              minLength={12}
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
            />
            {mode === "register" && (
              <small className="muted">Use at least 12 characters.</small>
            )}
          </label>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button className="button full-width" disabled={busy}>
            {busy
              ? mode === "signin"
                ? "Signing in…"
                : "Creating account…"
              : mode === "signin"
                ? "Sign in"
                : "Create account"}
          </button>
        </form>
        <p className="auth-switch">
          {mode === "signin"
            ? "New to Campus Sign?"
            : "Already have an account?"}{" "}
          <button
            type="button"
            className="inline-button"
            onClick={() => {
              setMode(mode === "signin" ? "register" : "signin");
              setError("");
            }}
          >
            {mode === "signin" ? "Create an account" : "Sign in"}
          </button>
        </p>
      </section>
    </div>
  );
}
