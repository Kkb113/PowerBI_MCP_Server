import { z } from "zod";
import type { FabricClient } from "../clients/fabric-client.js";
import type {
  FabricSqlClient,
  FabricSqlEndpoint,
  FabricSqlSampleResult,
  FabricSqlSchemaResult,
} from "../clients/fabric-sql-client.js";
import type { Lakehouse, LakehouseTable, Warehouse } from "../clients/schemas.js";
import { DomainError } from "../errors.js";
import { paginateValues, type Page } from "./pagination.js";

const uuidSchema = z.uuid();
const dataSourceTypeSchema = z.enum(["lakehouse", "warehouse"]);

type FabricDataOperations = Pick<
  FabricClient,
  "listLakehouses" | "getLakehouse" | "listLakehouseTables" | "listWarehouses" | "getWarehouse"
>;

type FabricSqlOperations = Pick<FabricSqlClient, "inspectSchema" | "sampleTable">;

export type FabricDataSourceType = z.infer<typeof dataSourceTypeSchema>;

export class FabricDataService {
  public constructor(
    private readonly fabric: FabricDataOperations,
    private readonly sql: FabricSqlOperations,
  ) {}

  public async listLakehouses(workspaceId: string, input: unknown = {}): Promise<Page<Lakehouse>> {
    const validWorkspaceId = this.uuid(workspaceId, "list_lakehouses");
    const values = await this.fabric.listLakehouses(validWorkspaceId);
    return paginateValues(values, `lakehouses:${validWorkspaceId}`, input);
  }

  public async getLakehouse(workspaceId: string, lakehouseId: string): Promise<Lakehouse> {
    return await this.fabric.getLakehouse(
      this.uuid(workspaceId, "get_lakehouse"),
      this.uuid(lakehouseId, "get_lakehouse"),
    );
  }

  public async listLakehouseTables(
    workspaceId: string,
    lakehouseId: string,
    input: unknown = {},
  ): Promise<Page<LakehouseTable>> {
    const validWorkspaceId = this.uuid(workspaceId, "list_lakehouse_tables");
    const validLakehouseId = this.uuid(lakehouseId, "list_lakehouse_tables");
    const values = await this.fabric.listLakehouseTables(validWorkspaceId, validLakehouseId);
    return paginateValues(values, `lakehouseTables:${validWorkspaceId}:${validLakehouseId}`, input);
  }

  public async listWarehouses(workspaceId: string, input: unknown = {}): Promise<Page<Warehouse>> {
    const validWorkspaceId = this.uuid(workspaceId, "list_warehouses");
    const values = await this.fabric.listWarehouses(validWorkspaceId);
    return paginateValues(values, `warehouses:${validWorkspaceId}`, input);
  }

  public async getWarehouse(workspaceId: string, warehouseId: string): Promise<Warehouse> {
    return await this.fabric.getWarehouse(
      this.uuid(workspaceId, "get_warehouse"),
      this.uuid(warehouseId, "get_warehouse"),
    );
  }

  public async inspectSchema(input: {
    readonly workspaceId: string;
    readonly itemType: FabricDataSourceType;
    readonly itemId: string;
    readonly schemaName?: string;
    readonly tableName?: string;
    readonly maxColumns: number;
  }): Promise<FabricSqlSchemaResult> {
    const endpoint = await this.resolveEndpoint(
      input.workspaceId,
      input.itemType,
      input.itemId,
      "inspect_data_source_schema",
    );
    return await this.sql.inspectSchema(endpoint, {
      ...(input.schemaName === undefined ? {} : { schemaName: input.schemaName }),
      ...(input.tableName === undefined ? {} : { tableName: input.tableName }),
      maxColumns: input.maxColumns,
    });
  }

  public async sampleTable(input: {
    readonly workspaceId: string;
    readonly itemType: FabricDataSourceType;
    readonly itemId: string;
    readonly schemaName: string;
    readonly tableName: string;
    readonly columns?: readonly string[];
    readonly maxRows: number;
  }): Promise<FabricSqlSampleResult> {
    const endpoint = await this.resolveEndpoint(
      input.workspaceId,
      input.itemType,
      input.itemId,
      "sample_data_source_table",
    );
    return await this.sql.sampleTable(endpoint, {
      schemaName: input.schemaName,
      tableName: input.tableName,
      ...(input.columns === undefined ? {} : { columns: input.columns }),
      maxRows: input.maxRows,
    });
  }

  private async resolveEndpoint(
    workspaceId: string,
    itemType: FabricDataSourceType,
    itemId: string,
    operation: string,
  ): Promise<FabricSqlEndpoint> {
    const validWorkspaceId = this.uuid(workspaceId, operation);
    const validItemId = this.uuid(itemId, operation);
    const validItemType = dataSourceTypeSchema.parse(itemType);
    if (validItemType === "warehouse") {
      const warehouse = await this.fabric.getWarehouse(validWorkspaceId, validItemId);
      return {
        server: warehouse.properties.connectionString,
        database: warehouse.displayName,
      };
    }

    const lakehouse = await this.fabric.getLakehouse(validWorkspaceId, validItemId);
    if (lakehouse.properties.sqlEndpointProperties.provisioningStatus !== "Success") {
      throw new DomainError(
        "SQL_ENDPOINT_NOT_READY",
        "The Lakehouse SQL analytics endpoint is not ready for inspection.",
      );
    }
    return {
      server: lakehouse.properties.sqlEndpointProperties.connectionString,
      database: lakehouse.displayName,
    };
  }

  private uuid(value: string, operation: string): string {
    const parsed = uuidSchema.safeParse(value);
    if (!parsed.success) {
      throw new DomainError("INVALID_REQUEST", `${operation} requires valid UUID identifiers.`);
    }
    return parsed.data;
  }
}
