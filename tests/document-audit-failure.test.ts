import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  queries: [] as string[],
  identity: {
    userId: "55555555-5555-4555-8555-555555555555",
    email: "requester@example.test",
    displayName: "Requester",
  },
  removeSource: vi.fn(async () => undefined),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));
vi.mock("@/services/auth", () => ({
  authenticationService: { readSession: () => state.identity },
}));
vi.mock("@/db/client", () => ({
  pool: {
    query: vi.fn(),
    connect: async () => ({
      query: async (sql: string) => {
        state.queries.push(sql);
        return { rows: [] };
      },
      release: vi.fn(),
    }),
  },
}));
vi.mock("@/services/pdf", () => ({
  MAX_PDF_BYTES: 10 * 1024 * 1024,
  pdfService: { validate: async () => ({ pageCount: 1, byteLength: 8 }) },
}));
vi.mock("@/services/storage", () => ({
  documentStorage: {
    put: async () => "source/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf",
    get: async () => Buffer.from("%PDF-test"),
    removeSource: state.removeSource,
  },
}));
vi.mock("@/services/integrity", () => ({
  integrityService: { hash: () => Buffer.alloc(32, 1) },
}));
vi.mock("@/services/audit", () => ({
  appendAuditEventInTransaction: async () => {
    throw new Error("audit database unavailable");
  },
  auditService: {},
}));

describe("document creation audit boundary", () => {
  beforeEach(() => {
    state.queries.length = 0;
    state.removeSource.mockClear();
  });

  it("rolls back and returns an error when the required creation audit cannot persist", async () => {
    const { POST } = await import("@/app/api/documents/route");
    const form = new FormData();
    form.set("title", "Test OD");
    form.set("letterType", "OD");
    form.set(
      "file",
      new Blob(["%PDF-test"], { type: "application/pdf" }),
      "draft.pdf",
    );
    const response = await POST(
      new NextRequest("http://localhost/api/documents", {
        method: "POST",
        body: form,
      }),
    );
    expect(response.status).toBe(503);
    expect(state.queries).toContain("rollback");
    expect(state.queries).not.toContain("commit");
    expect(state.removeSource).toHaveBeenCalledOnce();
  });
});
