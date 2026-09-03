import { Connection, Request, TYPES, type ConnectionConfiguration } from "tedious";
import { z } from "zod";
import type { AccessTokenProvider } from "../identity.js";
import type { JsonValue } from "../mcp/schemas.js";
import { ApiError } from "./errors.js";

const fabricSqlHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+datawarehouse\.fabric\.microsoft\.com$/u,
    "must be a Microsoft Fabric Data Warehouse endpoint hostname",
  );
const databaseNameSchema = z.string().trim().min(1).max(256);
const identifierSchema = z.string().trim().min(1).max(256);
const maxColumnsSchema = z.number().int().min(1).max(2_000);
const maxRowsSchema = z.number().int().min(1).max(1_000);

const schemaColumnRowSchema = z.object({
  schemaName: z.string(),
  tableName: z.string(),
  objectType: z.string(),
  columnName: z.string(),
  ordinalPosition: z.number().int(),
  dataType: z.string(),
  maximumLength: z.number().int().nullable(),
  numericPrecision: z.number().int().nullable(),
  numericScale: z.number().int().nullable(),
  isNullable: z.string().transform((value) => value.toUpperCase() === "YES"),
});

export interface FabricSqlEndpoint {
  readonly server: string;
  readonly database: string;
}

export type FabricSqlSchemaColumn = z.output<typeof schemaColumnRowSchema>;

export interface FabricSqlSchemaResult {
  readonly columns: readonly FabricSqlSchemaColumn[];
  readonly truncated: boolean;
  readonly effectiveMaxColumns: number;
}

export interface FabricSqlSampleResult {
  readonly rows: readonly Readonly<Record<string, JsonValue>>[];
  readonly returnedRows: number;
  readonly effectiveMaxRows: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly ("response_bytes" | "row_cap")[];
}

export interface FabricSqlClientOptions {
  readonly timeoutMs: number;
  readonly maxRows: number;
  readonly maxResponseBytes: number;
}

interface SqlParameter {
  readonly name: string;
  readonly kind: "int" | "nvarchar";
  readonly value: number | string | null;
}

interface SqlColumnValue {
  readonly metadata: { readonly colName: string };
  readonly value: unknown;
}

interface SqlConnection {
  connect(listener: (error?: Error) => void): void;
  close(): void;
  execSql(request: Request): void;
}

export type SqlConnectionFactory = (configuration: ConnectionConfiguration) => SqlConnection;

const defaultConnectionFactory: SqlConnectionFactory = (configuration) =>
  new Connection(configuration);

export const quoteSqlIdentifier = (identifier: string): string => {
  const escaped = identifier.replace(/\]/gu, "]]");
  return "[" + escaped + "]";
};

const normalizeSqlValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    return { encoding: "base64", data: Buffer.from(value).toString("base64") };
  }
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
    if (serialized !== undefined) return JSON.parse(serialized) as JsonValue;
  } catch {
    // Fall through to a bounded string representation.
  }
  if (typeof value === "symbol") return value.description ?? "symbol";
  if (typeof value === "function") return value.name || "function";
  return "unserializable-sql-value";
};

export class FabricSqlClient {
  private readonly options: FabricSqlClientOptions;

  public constructor(
    private readonly tokenProvider: AccessTokenProvider,
    options: FabricSqlClientOptions,
    private readonly connectionFactory: SqlConnectionFactory = defaultConnectionFactory,
  ) {
    this.options = {
      timeoutMs: z.number().int().min(100).max(120_000).parse(options.timeoutMs),
      maxRows: maxRowsSchema.parse(options.maxRows),
      maxResponseBytes: z.number().int().min(1_024).max(10_485_760).parse(options.maxResponseBytes),
    };
  }

  public async inspectSchema(
    endpoint: FabricSqlEndpoint,
    input: {
      readonly schemaName?: string;
      readonly tableName?: string;
      readonly maxColumns: number;
    },
  ): Promise<FabricSqlSchemaResult> {
    const maxColumns = maxColumnsSchema.parse(input.maxColumns);
    const schemaName = input.schemaName ? identifierSchema.parse(input.schemaName) : null;
    const tableName = input.tableName ? identifierSchema.parse(input.tableName) : null;
    const rows = await this.execute(
      endpoint,
      "inspect_data_source_schema",
      `SELECT TOP (@resultLimit)
  c.TABLE_SCHEMA AS schemaName,
  c.TABLE_NAME AS tableName,
  t.TABLE_TYPE AS objectType,
  c.COLUMN_NAME AS columnName,
  c.ORDINAL_POSITION AS ordinalPosition,
  c.DATA_TYPE AS dataType,
  c.CHARACTER_MAXIMUM_LENGTH AS maximumLength,
  c.NUMERIC_PRECISION AS numericPrecision,
  c.NUMERIC_SCALE AS numericScale,
  c.IS_NULLABLE AS isNullable
FROM INFORMATION_SCHEMA.COLUMNS AS c
INNER JOIN INFORMATION_SCHEMA.TABLES AS t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
WHERE (@schemaName IS NULL OR c.TABLE_SCHEMA = @schemaName)
  AND (@tableName IS NULL OR c.TABLE_NAME = @tableName)
ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION;`,
      [
        { name: "resultLimit", kind: "int", value: maxColumns + 1 },
        { name: "schemaName", kind: "nvarchar", value: schemaName },
        { name: "tableName", kind: "nvarchar", value: tableName },
      ],
    );
    const parsed = rows.slice(0, maxColumns).map((row) => schemaColumnRowSchema.parse(row));
    return {
      columns: parsed,
      truncated: rows.length > maxColumns,
      effectiveMaxColumns: maxColumns,
    };
  }

  public async sampleTable(
    endpoint: FabricSqlEndpoint,
    input: {
      readonly schemaName: string;
      readonly tableName: string;
      readonly columns?: readonly string[];
      readonly maxRows: number;
    },
  ): Promise<FabricSqlSampleResult> {
    const schemaName = identifierSchema.parse(input.schemaName);
    const tableName = identifierSchema.parse(input.tableName);
    const requestedMaxRows = maxRowsSchema.parse(input.maxRows);
    const effectiveMaxRows = Math.min(requestedMaxRows, this.options.maxRows);
    const selectedColumns = input.columns?.map((column) => identifierSchema.parse(column));
    const projection = selectedColumns?.length
      ? selectedColumns.map(quoteSqlIdentifier).join(", ")
      : "*";
    const rows = await this.execute(
      endpoint,
      "sample_data_source_table",
      `SELECT TOP (@resultLimit) ${projection} FROM ${quoteSqlIdentifier(schemaName)}.${quoteSqlIdentifier(tableName)};`,
      [{ name: "resultLimit", kind: "int", value: effectiveMaxRows + 1 }],
    );

    const value: Readonly<Record<string, JsonValue>>[] = [];
    let bytes = 256;
    let responseBytesExceeded = false;
    for (const row of rows.slice(0, effectiveMaxRows)) {
      const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
      if (bytes + rowBytes > this.options.maxResponseBytes) {
        responseBytesExceeded = true;
        break;
      }
      value.push(row);
      bytes += rowBytes;
    }
    const rowLimitExceeded = rows.length > effectiveMaxRows;
    return {
      rows: value,
      returnedRows: value.length,
      effectiveMaxRows,
      truncated: rowLimitExceeded || responseBytesExceeded,
      truncationReasons: [
        ...(rowLimitExceeded ? (["row_cap"] as const) : []),
        ...(responseBytesExceeded ? (["response_bytes"] as const) : []),
      ],
    };
  }

  private async execute(
    rawEndpoint: FabricSqlEndpoint,
    operation: string,
    statement: string,
    parameters: readonly SqlParameter[],
  ): Promise<readonly Readonly<Record<string, JsonValue>>[]> {
    const endpointResult = z
      .object({ server: fabricSqlHostSchema, database: databaseNameSchema })
      .safeParse({
        server: rawEndpoint.server,
        database: rawEndpoint.database,
      });
    if (!endpointResult.success) {
      throw new ApiError(
        "INVALID_API_RESPONSE",
        "Fabric returned an invalid SQL endpoint configuration.",
        { service: "fabric-sql", operation, cause: endpointResult.error },
      );
    }
    const endpoint = endpointResult.data;
    const token = await this.tokenProvider.getAccessToken("fabric-sql");
    let connection: SqlConnection | undefined;

    try {
      connection = this.connectionFactory({
        server: endpoint.server,
        authentication: {
          type: "azure-active-directory-access-token",
          options: { token },
        },
        options: {
          database: endpoint.database,
          encrypt: true,
          trustServerCertificate: false,
          connectTimeout: this.options.timeoutMs,
          requestTimeout: this.options.timeoutMs,
          cancelTimeout: 5_000,
          textsize: Math.min(this.options.maxResponseBytes, 1_048_576),
          appName: "fabric-semantic-model-mcp",
        },
      });
      await new Promise<void>((resolve, reject) => {
        connection?.connect((error) => (error ? reject(error) : resolve()));
      });
      return await new Promise<readonly Readonly<Record<string, JsonValue>>[]>(
        (resolve, reject) => {
          const rows: Readonly<Record<string, JsonValue>>[] = [];
          const request = new Request(statement, (error) =>
            error ? reject(error) : resolve(rows),
          );
          for (const parameter of parameters) {
            request.addParameter(
              parameter.name,
              parameter.kind === "int" ? TYPES.Int : TYPES.NVarChar,
              parameter.value,
              parameter.kind === "nvarchar" ? { length: 256 } : undefined,
            );
          }
          request.on("row", (rawColumns) => {
            const row: Record<string, JsonValue> = {};
            for (const [index, column] of (rawColumns as readonly SqlColumnValue[]).entries()) {
              const name = column.metadata.colName || `column_${index + 1}`;
              row[name] = normalizeSqlValue(column.value);
            }
            rows.push(row);
          });
          connection?.execSql(request);
        },
      );
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        throw new ApiError("INVALID_REQUEST", "The Fabric SQL endpoint request was invalid.", {
          service: "fabric-sql",
          operation,
          cause: error,
        });
      }
      throw new ApiError("FABRIC_SQL_QUERY_FAILED", "The Fabric SQL read query failed.", {
        service: "fabric-sql",
        operation,
        cause: error,
      });
    } finally {
      connection?.close();
    }
  }
}
