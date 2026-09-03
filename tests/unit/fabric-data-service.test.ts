import { describe, expect, it, vi } from "vitest";
import type { FabricClient } from "../../src/clients/fabric-client.js";
import type { FabricSqlClient } from "../../src/clients/fabric-sql-client.js";
import { FabricDataService } from "../../src/services/fabric-data-service.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LAKEHOUSE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WAREHOUSE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SQL_ENDPOINT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const lakehouse = {
  id: LAKEHOUSE_ID,
  displayName: "Sales Lakehouse",
  type: "Lakehouse" as const,
  workspaceId: WORKSPACE_ID,
  properties: {
    oneLakeTablesPath: "https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables",
    oneLakeFilesPath: "https://onelake.dfs.fabric.microsoft.com/ws/lh/Files",
    sqlEndpointProperties: {
      connectionString: "lake.datawarehouse.fabric.microsoft.com",
      id: SQL_ENDPOINT_ID,
      provisioningStatus: "Success",
    },
  },
};

const warehouse = {
  id: WAREHOUSE_ID,
  displayName: "Sales Warehouse",
  type: "Warehouse" as const,
  workspaceId: WORKSPACE_ID,
  properties: { connectionString: "warehouse.datawarehouse.fabric.microsoft.com" },
};

const createHarness = () => {
  const getLakehouse = vi.fn().mockResolvedValue(lakehouse);
  const fabric = {
    listLakehouses: vi.fn().mockResolvedValue([lakehouse, { ...lakehouse, id: SQL_ENDPOINT_ID }]),
    getLakehouse,
    listLakehouseTables: vi
      .fn()
      .mockResolvedValue([
        { name: "Sales", type: "Managed", format: "delta", location: "abfss://sales" },
      ]),
    listWarehouses: vi.fn().mockResolvedValue([warehouse]),
    getWarehouse: vi.fn().mockResolvedValue(warehouse),
  } as unknown as FabricClient;
  const inspectSchema = vi.fn().mockResolvedValue({
    columns: [{ schemaName: "dbo", tableName: "Sales", columnName: "Amount" }],
    truncated: false,
    effectiveMaxColumns: 50,
  });
  const sampleTable = vi.fn().mockResolvedValue({
    rows: [{ Amount: 100 }],
    returnedRows: 1,
    effectiveMaxRows: 10,
    truncated: false,
    truncationReasons: [],
  });
  const sql = {
    inspectSchema,
    sampleTable,
  } as unknown as FabricSqlClient;
  return {
    fabric,
    sql,
    fabricMocks: { getLakehouse },
    sqlMocks: { inspectSchema, sampleTable },
    service: new FabricDataService(fabric, sql),
  };
};

describe("FabricDataService", () => {
  it("pages Lakehouse, table, and Warehouse discovery results", async () => {
    const { service } = createHarness();
    const first = await service.listLakehouses(WORKSPACE_ID, { limit: 1 });
    expect(first.value).toEqual([lakehouse]);
    expect(first.continuationToken).toBeTypeOf("string");
    await expect(
      service.listLakehouses(WORKSPACE_ID, {
        limit: 1,
        continuationToken: first.continuationToken,
      }),
    ).resolves.toMatchObject({ value: [{ id: SQL_ENDPOINT_ID }] });
    await expect(service.listLakehouseTables(WORKSPACE_ID, LAKEHOUSE_ID)).resolves.toMatchObject({
      value: [{ name: "Sales" }],
    });
    await expect(service.listWarehouses(WORKSPACE_ID)).resolves.toEqual({ value: [warehouse] });
    await expect(service.getLakehouse(WORKSPACE_ID, LAKEHOUSE_ID)).resolves.toEqual(lakehouse);
    await expect(service.getWarehouse(WORKSPACE_ID, WAREHOUSE_ID)).resolves.toEqual(warehouse);
  });

  it("resolves Lakehouse and Warehouse endpoints before schema and sample reads", async () => {
    const { service, sqlMocks } = createHarness();
    await service.inspectSchema({
      workspaceId: WORKSPACE_ID,
      itemType: "lakehouse",
      itemId: LAKEHOUSE_ID,
      schemaName: "dbo",
      maxColumns: 50,
    });
    expect(sqlMocks.inspectSchema).toHaveBeenCalledWith(
      {
        server: lakehouse.properties.sqlEndpointProperties.connectionString,
        database: "Sales Lakehouse",
      },
      { schemaName: "dbo", maxColumns: 50 },
    );

    await service.sampleTable({
      workspaceId: WORKSPACE_ID,
      itemType: "warehouse",
      itemId: WAREHOUSE_ID,
      schemaName: "dbo",
      tableName: "Sales",
      columns: ["Amount"],
      maxRows: 10,
    });
    expect(sqlMocks.sampleTable).toHaveBeenCalledWith(
      { server: warehouse.properties.connectionString, database: "Sales Warehouse" },
      { schemaName: "dbo", tableName: "Sales", columns: ["Amount"], maxRows: 10 },
    );
  });

  it("rejects invalid identifiers and Lakehouses whose SQL endpoint is not ready", async () => {
    const { service, fabricMocks, sqlMocks } = createHarness();
    await expect(service.listLakehouses("bad")).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    fabricMocks.getLakehouse.mockResolvedValue({
      ...lakehouse,
      properties: {
        ...lakehouse.properties,
        sqlEndpointProperties: {
          ...lakehouse.properties.sqlEndpointProperties,
          provisioningStatus: "InProgress",
        },
      },
    });
    await expect(
      service.inspectSchema({
        workspaceId: WORKSPACE_ID,
        itemType: "lakehouse",
        itemId: LAKEHOUSE_ID,
        maxColumns: 50,
      }),
    ).rejects.toMatchObject({ code: "SQL_ENDPOINT_NOT_READY" });
    expect(sqlMocks.inspectSchema).not.toHaveBeenCalled();
  });
});
