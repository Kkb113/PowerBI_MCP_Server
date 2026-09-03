import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { FabricDataService } from "../src/services/fabric-data-service.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be true for the live Fabric data inspection smoke check.",
    ]);
  }

  const logger = createLogger({
    level: "error",
    knownSecrets: [
      ...(config.auth.mode === "api-key" ? [config.auth.apiKey] : []),
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const clients = createMicrosoftApiClients(config, logger);
  const data = new FabricDataService(clients.fabric, clients.fabricSql);
  const workspaces = await clients.fabric.listWorkspaces();
  let lakehouseCount = 0;
  let warehouseCount = 0;
  let listedLakehouseTableCount = 0;
  let inspectedItemType: "lakehouse" | "warehouse" | undefined;
  let inspectedColumnCount = 0;
  let inspectionTruncated = false;
  let sampledRowCount = 0;

  for (const workspace of workspaces) {
    const lakehouses = await clients.fabric.listLakehouses(workspace.id);
    const warehouses = await clients.fabric.listWarehouses(workspace.id);
    lakehouseCount += lakehouses.length;
    warehouseCount += warehouses.length;

    if (inspectedItemType) continue;
    const readyLakehouse = lakehouses.find(
      (lakehouse) => lakehouse.properties.sqlEndpointProperties.provisioningStatus === "Success",
    );
    if (readyLakehouse) {
      const lakehouseTables = await clients.fabric.listLakehouseTables(
        workspace.id,
        readyLakehouse.id,
      );
      listedLakehouseTableCount = lakehouseTables.length;
    }
    const item = readyLakehouse ?? warehouses[0];
    if (!item) continue;
    inspectedItemType = item.type === "Lakehouse" ? "lakehouse" : "warehouse";
    const schema = await data.inspectSchema({
      workspaceId: workspace.id,
      itemType: inspectedItemType,
      itemId: item.id,
      maxColumns: 25,
    });
    inspectedColumnCount = schema.columns.length;
    inspectionTruncated = schema.truncated;
    const firstColumn = schema.columns[0];
    if (firstColumn) {
      const sample = await data.sampleTable({
        workspaceId: workspace.id,
        itemType: inspectedItemType,
        itemId: item.id,
        schemaName: firstColumn.schemaName,
        tableName: firstColumn.tableName,
        columns: [firstColumn.columnName],
        maxRows: 1,
      });
      sampledRowCount = sample.returnedRows;
    }
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      visibleWorkspaceCount: workspaces.length,
      lakehouseCount,
      warehouseCount,
      listedLakehouseTableCount,
      inspectedItemType: inspectedItemType ?? null,
      inspectedColumnCount,
      inspectionTruncated,
      sampledRowCount,
      exposedDataRows: 0,
    })}\n`,
  );
}

try {
  await main();
} catch (error: unknown) {
  const logger = createLogger({
    level: "error",
    knownSecrets: [process.env["MCP_API_KEY"] ?? "", process.env["AZURE_CLIENT_SECRET"] ?? ""],
  });
  logger.error("Live Fabric data inspection smoke check failed", { error });
  process.exitCode = 1;
}
