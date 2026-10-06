import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authenticationService } from "@/services/auth";

export function requestIdFrom(request: Request): string {
  const provided = request.headers.get("x-request-id");
  return provided && /^[a-zA-Z0-9._:-]{1,100}$/.test(provided)
    ? provided
    : randomUUID();
}

export async function requester() {
  const cookieStore = await cookies();
  return authenticationService.readSession(
    cookieStore.get("od_session")?.value,
  );
}

export function apiError(
  requestId: string,
  status: number,
  code: string,
  message: string,
  fieldErrors?: Record<string, string[]>,
) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        requestId,
        ...(fieldErrors ? { fieldErrors } : {}),
      },
    },
    { status },
  );
}

export function databaseErrorCode(error: unknown): string | null {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate?.code ?? candidate?.cause?.code ?? null;
}
