import { NextRequest, NextResponse } from "next/server";
import { authenticationService } from "@/services/auth";
export async function GET(request: NextRequest) {
  const identity = await authenticationService.readSession(
    request.cookies.get("od_session")?.value,
  );
  return NextResponse.json(
    identity
      ? { authenticated: true, user: identity }
      : { authenticated: false },
    { status: identity ? 200 : 401 },
  );
}
