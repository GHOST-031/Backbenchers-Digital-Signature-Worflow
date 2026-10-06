import { NextRequest } from "next/server";
import { apiError, requestIdFrom, requester } from "../../http";
import { sendDocument, SigningError } from "@/services/sequential-signing";

type Context = { params: Promise<{ documentId: string }> };
export async function POST(request: NextRequest, context: Context) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const { documentId } = await context.params;
  try {
    const result = await sendDocument(documentId, identity.userId);
    return Response.json({ ...result, requestId });
  } catch (error) {
    if (error instanceof SigningError)
      return apiError(requestId, error.status, error.code, error.message);
    return apiError(
      requestId,
      503,
      "WORKFLOW_UNAVAILABLE",
      "The document could not be sent",
    );
  }
}
