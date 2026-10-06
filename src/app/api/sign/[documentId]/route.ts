import { NextRequest } from "next/server";
import { apiError, requestIdFrom, requester } from "@/app/api/documents/http";
import { getSigningContext, SigningError } from "@/services/sequential-signing";

type Context = { params: Promise<{ documentId: string }> };
export async function GET(request: NextRequest, context: Context) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  try {
    return Response.json({
      context: await getSigningContext(
        (await context.params).documentId,
        identity.userId,
      ),
      requestId,
    });
  } catch (error) {
    if (error instanceof SigningError)
      return apiError(requestId, error.status, error.code, error.message);
    return apiError(
      requestId,
      503,
      "SIGNING_UNAVAILABLE",
      "Signing context is unavailable",
    );
  }
}
