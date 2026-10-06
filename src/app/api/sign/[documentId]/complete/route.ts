import { z } from "zod";
import { NextRequest } from "next/server";
import { apiError, requestIdFrom, requester } from "@/app/api/documents/http";
import { completeSigner, SigningError } from "@/services/sequential-signing";
import {
  finalizationService,
  FinalizationError,
} from "@/services/finalization";

const schema = z.object({ requestId: z.string().uuid() });
type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: NextRequest, context: Context) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      requestId,
      422,
      "INVALID_REQUEST",
      "A requestId is required",
    );
  try {
    const result = await completeSigner(
      (await context.params).documentId,
      identity.userId,
      parsed.data.requestId,
    );
    if ("sealJobId" in result && result.sealJobId) {
      const sealed = await finalizationService.processJob(result.sealJobId);
      return Response.json({
        ...result,
        documentStatus: "COMPLETED",
        finalVersionId: sealed.versionId,
        reused: sealed.reused,
        requestId,
      });
    }
    return Response.json({ ...result, requestId });
  } catch (error) {
    if (error instanceof SigningError)
      return apiError(requestId, error.status, error.code, error.message);
    if (error instanceof FinalizationError)
      return apiError(
        requestId,
        error.status >= 500 ? 503 : error.status,
        error.code,
        error.message,
      );
    return apiError(
      requestId,
      503,
      "COMPLETION_UNAVAILABLE",
      "The signer could not be completed",
    );
  }
}
