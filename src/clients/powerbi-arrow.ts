import { CompressionType, RecordBatchReader, compressionRegistry, type Codec } from "apache-arrow";
import { compress, decompress } from "lz4js";
import type { JsonValue } from "../mcp/schemas.js";
import type { ExecuteQueriesResponse } from "./schemas.js";

const lz4Codec: Codec = {
  encode: (value) => compress(value),
  decode: (value) => decompress(value),
};

if (compressionRegistry.get(CompressionType.LZ4_FRAME) === null) {
  compressionRegistry.set(CompressionType.LZ4_FRAME, lz4Codec);
}

const metadataValue = (metadata: ReadonlyMap<string, string>, name: string): string | undefined => {
  const expected = name.toLocaleLowerCase("en-US");
  for (const [key, value] of metadata) {
    if (key.toLocaleLowerCase("en-US") === expected) return value;
  }
  return undefined;
};

const toJsonValue = (value: unknown): JsonValue => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entry]) => [String(key), toJsonValue(entry)]),
    );
  }
  if (typeof value === "object") {
    const candidate = value as { readonly toJSON?: () => unknown };
    if (typeof candidate.toJSON === "function") {
      const json = candidate.toJSON();
      if (json !== value) return toJsonValue(json);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  throw new TypeError(`Power BI returned an unsupported Arrow value type: ${typeof value}.`);
};

const readRows = (
  reader: RecordBatchReader,
  includeNulls: boolean,
): Readonly<Record<string, JsonValue>>[] => {
  if (!reader.isSync()) {
    throw new TypeError("Power BI returned an unexpected asynchronous Arrow reader.");
  }
  const rows: Array<Readonly<Record<string, JsonValue>>> = [];
  for (const batch of reader) {
    for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex += 1) {
      const row: Record<string, JsonValue> = {};
      for (let fieldIndex = 0; fieldIndex < batch.schema.fields.length; fieldIndex += 1) {
        const field = batch.schema.fields[fieldIndex];
        const value: unknown = batch.getChildAt(fieldIndex)?.get(rowIndex);
        if (field && (includeNulls || (value !== null && value !== undefined))) {
          row[field.name] = toJsonValue(value);
        }
      }
      rows.push(row);
    }
  }
  return rows;
};

const firstString = (
  row: Readonly<Record<string, JsonValue>> | undefined,
  ...names: readonly string[]
): string | undefined => {
  for (const name of names) {
    const value = row?.[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
};

export function parseExecuteDaxArrowResponse(
  bytes: Uint8Array,
  includeNulls: boolean,
): ExecuteQueriesResponse {
  const results: ExecuteQueriesResponse["results"] = [];
  for (const reader of RecordBatchReader.readAll(bytes)) {
    const isError = metadataValue(reader.schema.metadata, "IsError")?.toLowerCase() === "true";
    const rows = readRows(reader, isError || includeNulls);
    if (isError) {
      const row = rows[0];
      const code =
        metadataValue(reader.schema.metadata, "FaultCode") ??
        firstString(row, "ErrorCode", "errorCode");
      const message =
        metadataValue(reader.schema.metadata, "FaultString") ??
        firstString(row, "ErrorMessage", "errorMessage", "ErrorDescription", "errorDescription") ??
        "Power BI returned a DAX query error.";
      results.push({ error: { ...(code ? { code } : {}), message } });
      continue;
    }
    results.push({ tables: [{ rows }] });
  }
  if (results.length === 0) {
    throw new TypeError("Power BI returned no Arrow result streams.");
  }
  return { results };
}
