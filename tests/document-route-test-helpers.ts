import { randomUUID } from "node:crypto";
import { vi } from "vitest";

const state = vi.hoisted(() => ({ cookie: "" }));
export const cookieState = {
  get value() {
    return state.cookie;
  },
  set value(value: string) {
    state.cookie = value;
  },
};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "od_session" && state.cookie
        ? { value: state.cookie }
        : undefined,
  }),
}));

export async function createUser(label: string) {
  const { pool } = await import("@/db/client");
  const { authenticationService } = await import("@/services/auth");
  const userId = randomUUID();
  const email = `${label}-${userId}@phase2.example.test`;
  await pool.query(
    "insert into users (id,email,display_name,password_hash) values ($1,$2,$3,'unused')",
    [userId, email, label],
  );
  const cookie = authenticationService.issueSession({
    userId,
    email,
    displayName: label,
  });
  return { userId, email, cookie };
}

export async function requestRoute(
  method: string,
  path: string,
  input?: {
    json?: unknown;
    fields?: { title: string; letterType: string };
    file?: Uint8Array;
  },
) {
  const { NextRequest } = await import("next/server");
  const headers = new Headers();
  let body: BodyInit | undefined;
  if (input?.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(input.json);
  } else if (input?.fields) {
    const form = new FormData();
    form.set("title", input.fields.title);
    form.set("letterType", input.fields.letterType);
    if (input.file)
      form.set(
        "file",
        new Blob([new Uint8Array(input.file)], { type: "application/pdf" }),
        "document.pdf",
      );
    body = form;
  }
  const request = new NextRequest(`http://localhost${path}`, {
    method,
    body,
    headers,
  });
  const segments = new URL(path, "http://localhost").pathname
    .split("/")
    .filter(Boolean);
  if (segments[0] === "api" && segments[1] === "auth") {
    if (segments[2] === "register") {
      const route = await import("@/app/api/auth/register/route");
      return route.POST(request);
    }
    if (segments[2] === "login") {
      const route = await import("@/app/api/auth/login/route");
      return route.POST(request);
    }
    if (segments[2] === "session") {
      const route = await import("@/app/api/auth/session/route");
      return route.GET(request);
    }
  }
  if (segments.length === 2 && segments[1] === "documents") {
    const route = await import("@/app/api/documents/route");
    return method === "GET" ? route.GET(request) : route.POST(request);
  }
  if (segments.length >= 3 && segments[1] === "documents") {
    const documentId = segments[2];
    if (segments.length === 3) {
      const route = await import("@/app/api/documents/[documentId]/route");
      return route.GET(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "signers") {
      const route =
        await import("@/app/api/documents/[documentId]/signers/route");
      return route.PUT(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "send") {
      const route = await import("@/app/api/documents/[documentId]/send/route");
      return route.POST(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "source") {
      const route =
        await import("@/app/api/documents/[documentId]/source/route");
      return route.GET(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "audit-events") {
      const route =
        await import("@/app/api/documents/[documentId]/audit-events/route");
      return route.GET(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "fields" && segments.length === 4) {
      const route =
        await import("@/app/api/documents/[documentId]/fields/route");
      return route.PUT(request, { params: Promise.resolve({ documentId }) });
    }
  }
  if (segments.length >= 3 && segments[1] === "sign") {
    const documentId = segments[2]!;
    if (segments.length === 3) {
      const route = await import("@/app/api/sign/[documentId]/route");
      return route.GET(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "complete") {
      const route = await import("@/app/api/sign/[documentId]/complete/route");
      return route.POST(request, { params: Promise.resolve({ documentId }) });
    }
    if (segments[3] === "fields" && segments[4]) {
      const route =
        await import("@/app/api/sign/[documentId]/fields/[fieldId]/route");
      return route.PUT(request, {
        params: Promise.resolve({ documentId, fieldId: segments[4] }),
      });
    }
  }
  throw new Error(`No route test helper for ${method} ${path}`);
}
