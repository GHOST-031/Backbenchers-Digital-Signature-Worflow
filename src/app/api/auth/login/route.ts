import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticationService } from "@/services/auth";
const inputSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12),
});
export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  try {
    const input = inputSchema.parse(await request.json());
    const user = await authenticationService.authenticate(
      input.email,
      input.password,
    );
    if (!user)
      return NextResponse.json(
        {
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Email or password is incorrect",
            requestId,
          },
        },
        { status: 401 },
      );
    const token = authenticationService.issueSession(user);
    const response = NextResponse.json({ user });
    response.cookies.set("od_session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 86400,
    });
    return response;
  } catch (error) {
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    return NextResponse.json(
      {
        error: {
          code: invalid ? "INVALID_INPUT" : "INTERNAL_ERROR",
          message: invalid
            ? "Check the submitted email and password"
            : "Could not sign in",
          requestId,
        },
      },
      { status: invalid ? 400 : 500 },
    );
  }
}
