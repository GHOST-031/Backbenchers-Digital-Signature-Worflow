"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

type User = { displayName: string; email: string } | null;

export function AppShell({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  async function signOut() {
    setBusy(true);
    setSignOutError(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setSignOutError(true);
        return;
      }
      router.push("/sign-in");
      router.refresh();
    } catch {
      setSignOutError(true);
    } finally {
      setBusy(false);
    }
  }
  const links = user
    ? [
        { href: "/dashboard", label: "Documents" },
        { href: "/documents/new", label: "Create request" },
      ]
    : [{ href: "/sign-in", label: "Sign in" }];
  return (
    <>
      <header className="app-header">
        <Link className="brand" href={user ? "/dashboard" : "/"}>
          <span className="brand-mark" aria-hidden="true">
            OD
          </span>
          <span>Campus Sign</span>
        </Link>
        <nav className="main-nav" aria-label="Main navigation">
          {links.map((link) => (
            <Link
              aria-current={
                pathname === link.href ||
                (link.href === "/dashboard" &&
                  (pathname.startsWith("/documents/") ||
                    pathname.startsWith("/sign/"))) ||
                (link.href !== "/dashboard" &&
                  pathname.startsWith(`${link.href}/`))
                  ? "page"
                  : undefined
              }
              className="nav-link"
              href={link.href}
              key={link.href}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        {user ? (
          <div className="account-area">
            <span className="account-name" title={user.email}>
              {user.displayName || user.email}
            </span>
            <button className="text-button" disabled={busy} onClick={signOut}>
              {busy ? "Signing out…" : "Sign out"}
            </button>
            {signOutError && (
              <span role="alert" className="account-error">
                Sign-out could not be confirmed. Please retry.
              </span>
            )}
          </div>
        ) : (
          <span className="account-area muted">Local demo workspace</span>
        )}
      </header>
      {children}
    </>
  );
}
