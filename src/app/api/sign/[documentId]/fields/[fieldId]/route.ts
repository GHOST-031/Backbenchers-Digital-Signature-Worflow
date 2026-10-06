import { z } from "zod";
import { NextRequest } from "next/server";
import { apiError, requestIdFrom, requester } from "@/app/api/documents/http";
import { SigningError, submitSignature } from "@/services/sequential-signing";

const schema = z
  .object({
    requestId: z.string().uuid(),
    method: z.enum(["TYPED", "DRAWN"]),
    value: z.string().max(350_000).optional(),
  })
  .refine((value) => Boolean(value.value), "Signature value is required");
type Context = { params: Promise<{ documentId: string; fieldId: string }> };
export async function PUT(request: NextRequest, context: Context) {
  const requestId = requestIdFrom(request);
  const identity = await requester();
  if (!identity)
    return apiError(requestId, 401, "UNAUTHENTICATED", "Sign in to continue");
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      requestId,
      422,
      "INVALID_SIGNATURE",
      "Signature data is invalid",
      { body: parsed.error.issues.map((issue) => issue.message) },
    );
  const { documentId, fieldId } = await context.params;
  try {
    const signature = await submitSignature({
      documentId,
      fieldId,
      userId: identity.userId,
      ...parsed.data,
    });
    return Response.json({ signature, requestId });
  } catch (error) {
    if (error instanceof SigningError)
      return apiError(requestId, error.status, error.code, error.message);
    return apiError(
      requestId,
      503,
      "SIGNATURE_UNAVAILABLE",
      "The signature could not be saved",
    );
  }
}
