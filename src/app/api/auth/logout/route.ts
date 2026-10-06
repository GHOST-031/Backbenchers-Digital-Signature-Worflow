import { NextRequest, NextResponse } from "next/server";
import { authenticationService } from "@/services/auth";

export async function POST(request: NextRequest) {
  let response: NextResponse;
  try {
    await authenticationService.revokeSession(
      request.cookies.get("od_session")?.value,
    );
    response = NextResponse.json({ signedOut: true });
  } catch {
    response = NextResponse.json(
      {
        error: {
          code: "SIGN_OUT_FAILED",
          message: "Could not securely sign out. Please try again.",
        },
      },
      { status: 503 },
    );
  }
  response.cookies.set("od_session", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  });
  return response;
}
