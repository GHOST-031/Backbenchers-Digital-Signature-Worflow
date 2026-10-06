import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticationService } from "@/services/auth";
const inputSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  password: z.string().min(12),
});
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const input = inputSchema.parse(await request.json());
    const user = await authenticationService.register(
      input.email,
      input.displayName,
      input.password,
    );
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    const candidate = error as { code?: string; cause?: { code?: string } };
    const duplicate =
      candidate.code === "23505" || candidate.cause?.code === "23505";
    const status = invalid ? 400 : duplicate ? 409 : 500;
    return NextResponse.json(
      {
        error: {
          code: invalid
            ? "INVALID_INPUT"
            : duplicate
              ? "ACCOUNT_EXISTS"
              : "INTERNAL_ERROR",
          message: invalid
            ? "Check the submitted account details"
            : duplicate
              ? "An account with this email already exists"
              : "Could not create account",
          requestId,
        },
      },
      { status },
    );
  }
}
