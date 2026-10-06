import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export async function GET() {
  try {
    const workerPath = path.join(
      process.cwd(),
      "node_modules",
      "pdfjs-dist",
      "build",
      "pdf.worker.min.mjs",
    );
    const worker = await readFile(workerPath);
    return new NextResponse(new Uint8Array(worker), {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: "PDF_WORKER_UNAVAILABLE",
          message: "PDF preview is unavailable",
        },
      },
      { status: 503 },
    );
  }
}
