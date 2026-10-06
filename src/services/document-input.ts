import { z } from "zod";

export const documentInputSchema = z.object({
  letterType: z.enum(["OD", "PERMISSION"]),
  title: z.string().trim().min(1).max(200),
});

const signerRoleValues = ["STUDENT", "FACULTY_ADVISOR", "HOD"] as const;
export const signerAssignmentSchema = z
  .array(
    z.object({
      sequence: z.number().int().min(1).max(3),
      role: z.enum(signerRoleValues),
      email: z
        .string()
        .trim()
        .email()
        .max(320)
        .transform((value) => value.toLowerCase()),
    }),
  )
  .length(3)
  .superRefine((assignments, context) => {
    for (let index = 0; index < signerRoleValues.length; index++) {
      const assignment = assignments[index];
      if (
        assignment?.sequence !== index + 1 ||
        assignment.role !== signerRoleValues[index]
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Assign Student, Faculty Advisor, and HoD in the required order",
          path: [index],
        });
      }
    }
    const ids = assignments.map(({ email }) => email);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Each workflow role must have a different application user",
        path: ["userId"],
      });
    }
  });

export const fieldSchema = z.object({
  id: z.string().uuid().optional(),
  signerId: z.string().uuid(),
  pageNumber: z.number().int().positive(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1),
  fieldType: z.enum(["SIGNATURE", "INITIALS", "DATE", "TEXT"]),
  required: z.boolean().default(true),
});
export const fieldsInputSchema = z.object({
  fields: z
    .array(fieldSchema)
    .max(300)
    .superRefine((fields, context) => {
      const ids = fields.flatMap((field) => (field.id ? [field.id] : []));
      if (new Set(ids).size !== ids.length)
        context.addIssue({
          code: "custom",
          message: "A field ID may appear only once",
          path: ["id"],
        });
    }),
});
export type FieldInput = z.infer<typeof fieldSchema>;

export function quantizeFieldGeometry(field: FieldInput): FieldInput {
  const quantize = (value: number) =>
    Math.round(value * 10_000_000) / 10_000_000;
  return {
    ...field,
    x: quantize(field.x),
    y: quantize(field.y),
    width: quantize(field.width),
    height: quantize(field.height),
  };
}

export function validateFieldPlacement(
  field: FieldInput,
  pageCount: number,
  signerIds: ReadonlySet<string>,
): string | null {
  if (!signerIds.has(field.signerId))
    return "Signer does not belong to this document";
  if (field.pageNumber > pageCount) return "Page number is outside the PDF";
  const { x, y, width, height } = quantizeFieldGeometry(field);
  if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1)
    return "Field geometry must fit within the page";
  return null;
}

export function readinessIssues(input: {
  hasSourcePdf: boolean;
  signers: Array<{ role: string; sequence: number; id: string }>;
  requiredFieldSignerIds: string[];
}): string[] {
  const issues: string[] = [];
  if (!input.hasSourcePdf) issues.push("A valid source PDF is required");
  const requiredRoles = ["STUDENT", "FACULTY_ADVISOR", "HOD"];
  if (
    input.signers.length !== 3 ||
    input.signers.some(
      (signer, index) =>
        signer.sequence !== index + 1 || signer.role !== requiredRoles[index],
    )
  ) {
    issues.push("All three signers must be assigned in the required order");
  }
  const requiredIds = new Set(input.requiredFieldSignerIds);
  for (const signer of input.signers) {
    if (!requiredIds.has(signer.id))
      issues.push(`A required signature field is missing for ${signer.role}`);
  }
  return issues;
}
