import { z } from "zod";
import { DomainError } from "../errors.js";

const paginationSchema = z.strictObject({
  continuationToken: z.string().min(1).max(8_192).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

const continuationPayloadSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().min(1),
  offset: z.number().int().min(1),
});

export interface Page<T> {
  readonly value: readonly T[];
  readonly continuationToken?: string;
}

const encodeContinuation = (scope: string, offset: number): string =>
  Buffer.from(JSON.stringify({ version: 1, scope, offset }), "utf8").toString("base64url");

const decodeContinuation = (token: string | undefined, scope: string): number => {
  if (!token) return 0;
  try {
    const payload = continuationPayloadSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as unknown,
    );
    if (payload.scope !== scope) throw new Error("scope mismatch");
    return payload.offset;
  } catch {
    throw new DomainError(
      "INVALID_CONTINUATION_TOKEN",
      "The continuation token is invalid for this collection.",
    );
  }
};

export function paginateValues<T>(values: readonly T[], scope: string, input: unknown): Page<T> {
  const parsed = paginationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("INVALID_REQUEST", "The pagination request is invalid.");
  }
  const offset = decodeContinuation(parsed.data.continuationToken, scope);
  if (offset > values.length) {
    throw new DomainError(
      "INVALID_CONTINUATION_TOKEN",
      "The continuation token points beyond the current collection.",
    );
  }
  const value = values.slice(offset, offset + parsed.data.limit);
  const nextOffset = offset + value.length;
  return {
    value,
    ...(nextOffset < values.length
      ? { continuationToken: encodeContinuation(scope, nextOffset) }
      : {}),
  };
}
