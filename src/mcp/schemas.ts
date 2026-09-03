import { z } from "zod";

export { modelChangeSchema, modelObjectTypeSchema, modelSpecSchema } from "../model/schemas.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const fabricIdSchema = z.uuid().describe("Microsoft Fabric UUID.");
export const definitionHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe("Lowercase SHA-256 hash of the normalized model definition.");

export const toolOutputSchema = z.object({
  ok: z.boolean(),
  status: z.enum(["success", "pending", "failed"]),
  message: z.string(),
  data: z.record(z.string(), jsonValueSchema).nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .nullable(),
});
