import { z } from "zod";
import { ApiError, type ExternalService } from "./errors.js";

const uuidSchema = z.uuid();

export function validateUuid(
  value: string,
  field: string,
  operation: string,
  service: ExternalService,
): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new ApiError("INVALID_IDENTIFIER", `${field} must be a valid UUID.`, {
      service,
      operation,
    });
  }
  return value;
}
