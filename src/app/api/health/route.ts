import { NextResponse } from "next/server";
import { checkDatabase } from "@/db/client";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await checkDatabase();
    return NextResponse.json({
      status: "ok",
      dependencies: { database: "ok" },
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json(
      { status: "unavailable", dependencies: { database: "unavailable" } },
      { status: 503 },
    );
  }
}
