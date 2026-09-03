import type { ConnectionConfiguration, Request } from "tedious";
import { describe, expect, it, vi } from "vitest";
import {
  FabricSqlClient,
  quoteSqlIdentifier,
  type SqlConnectionFactory,
} from "../../src/clients/fabric-sql-client.js";
import type { AccessTokenProvider } from "../../src/identity.js";

const endpoint = {
  server: "abc.zcf.datawarehouse.fabric.microsoft.com",
  database: "Sales Data",
};

type Row = Readonly<Record<string, unknown>>;

const columnsFor = (row: Row) =>
  Object.entries(row).map(([name, value]) => ({ metadata: { colName: name }, value }));

const createHarness = (
  rows: readonly Row[],
  options: { readonly connectError?: Error; readonly queryError?: Error } = {},
) => {
  const close = vi.fn();
  const requests: Request[] = [];
  const configurations: ConnectionConfiguration[] = [];
  const factory: SqlConnectionFactory = (configuration) => {
    configurations.push(configuration);
    return {
      connect: (listener) => listener(options.connectError),
      close,
      execSql: (request) => {
        requests.push(request);
        if (options.queryError) {
          request.callback(options.queryError);
          return;
        }
        for (const row of rows) request.emit("row", columnsFor(row));
        request.callback(null, rows.length);
      },
    };
  };
  const getAccessToken = vi.fn().mockResolvedValue("sql-access-token");
  const tokenProvider = { getAccessToken } as unknown as AccessTokenProvider;
  const client = new FabricSqlClient(
    tokenProvider,
    { timeoutMs: 5_000, maxRows: 2, maxResponseBytes: 1_024 },
    factory,
  );
  return { client, close, configurations, getAccessToken, requests };
};

describe("FabricSqlClient", () => {
  it("quotes SQL identifiers without changing spaces and escapes closing brackets", () => {
    expect(quoteSqlIdentifier("Order Details")).toBe("[Order Details]");
    expect(quoteSqlIdentifier("a]b")).toBe("[a]]b]");
  });

  it("inspects INFORMATION_SCHEMA with an Entra Fabric SQL token", async () => {
    const row = {
      schemaName: "dbo",
      tableName: "Sales",
      objectType: "BASE TABLE",
      columnName: "Amount",
      ordinalPosition: 1,
      dataType: "decimal",
      maximumLength: null,
      numericPrecision: 18,
      numericScale: 2,
      isNullable: "NO",
    };
    const harness = createHarness([row]);

    await expect(
      harness.client.inspectSchema(endpoint, {
        schemaName: "dbo",
        tableName: "Sales",
        maxColumns: 10,
      }),
    ).resolves.toEqual({
      columns: [{ ...row, isNullable: false }],
      truncated: false,
      effectiveMaxColumns: 10,
    });
    expect(harness.getAccessToken).toHaveBeenCalledWith("fabric-sql");
    expect(harness.configurations[0]).toMatchObject({
      server: endpoint.server,
      authentication: {
        type: "azure-active-directory-access-token",
        options: { token: "sql-access-token" },
      },
      options: { database: endpoint.database, encrypt: true, trustServerCertificate: false },
    });
    expect(harness.requests[0]?.sqlTextOrProcedure).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(harness.requests[0]?.parameters.map((parameter) => parameter.value)).toEqual([
      11,
      "dbo",
      "Sales",
    ]);
    expect(harness.close).toHaveBeenCalledOnce();
  });

  it("samples only a server-built SELECT TOP and normalizes non-JSON SQL values", async () => {
    const now = new Date("2026-09-03T00:00:00.000Z");
    const harness = createHarness([
      { Id: 1n, At: now, Payload: Buffer.from("ok") },
      { Id: 2n, At: now, Payload: null },
      { Id: 3n, At: now, Payload: null },
    ]);

    await expect(
      harness.client.sampleTable(endpoint, {
        schemaName: "sales schema",
        tableName: "order]facts",
        columns: ["Id", "Name With Space"],
        maxRows: 20,
      }),
    ).resolves.toMatchObject({
      rows: [
        {
          Id: "1",
          At: "2026-09-03T00:00:00.000Z",
          Payload: { encoding: "base64", data: "b2s=" },
        },
        { Id: "2", At: "2026-09-03T00:00:00.000Z", Payload: null },
      ],
      returnedRows: 2,
      effectiveMaxRows: 2,
      truncated: true,
      truncationReasons: ["row_cap"],
    });
    expect(harness.requests[0]?.sqlTextOrProcedure).toBe(
      "SELECT TOP (@resultLimit) [Id], [Name With Space] FROM [sales schema].[order]]facts];",
    );
    expect(harness.requests[0]?.parameters[0]?.value).toBe(3);
  });

  it("caps returned samples by serialized bytes", async () => {
    const harness = createHarness([{ Value: "x".repeat(2_000) }]);

    await expect(
      harness.client.sampleTable(endpoint, {
        schemaName: "dbo",
        tableName: "LargeRows",
        maxRows: 1,
      }),
    ).resolves.toMatchObject({
      returnedRows: 0,
      truncated: true,
      truncationReasons: ["response_bytes"],
    });
  });

  it("rejects non-Fabric endpoints and maps connection and query failures", async () => {
    const invalid = createHarness([]);
    await expect(
      invalid.client.sampleTable(
        { server: "attacker.example.test", database: "Sales" },
        { schemaName: "dbo", tableName: "Sales", maxRows: 1 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    expect(invalid.configurations).toHaveLength(0);

    const connectionFailure = createHarness([], { connectError: new Error("connect") });
    await expect(
      connectionFailure.client.inspectSchema(endpoint, { maxColumns: 10 }),
    ).rejects.toMatchObject({ code: "FABRIC_SQL_QUERY_FAILED" });
    expect(connectionFailure.close).toHaveBeenCalledOnce();

    const queryFailure = createHarness([], { queryError: new Error("query") });
    await expect(
      queryFailure.client.sampleTable(endpoint, {
        schemaName: "dbo",
        tableName: "Sales",
        maxRows: 1,
      }),
    ).rejects.toMatchObject({ code: "FABRIC_SQL_QUERY_FAILED" });
    expect(queryFailure.close).toHaveBeenCalledOnce();
  });
});
