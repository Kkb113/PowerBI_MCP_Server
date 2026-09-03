import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import type { JsonValue } from "../src/mcp/schemas.js";
import { TOOL_NAMES } from "../src/mcp/registry.js";
import type { ModelSpec } from "../src/model/index.js";
import { SemanticModelService } from "../src/services/semantic-model-service.js";
import { requireLiveTestWorkspaceId } from "./live-workspace.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

interface ToolEnvelope {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly data: Readonly<Record<string, JsonValue>> | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

interface SourceColumn {
  readonly schemaName: string;
  readonly tableName: string;
  readonly columnName: string;
  readonly ordinalPosition: number;
  readonly dataType: string;
}

const uuidSchema = z.uuid();
const identifierSchema = z.string().trim().min(1).max(256);
const MCP_REQUEST_TIMEOUT_MS = 180_000;
const REFRESH_TIMEOUT_MS = 300_000;

const listen = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const modelDataType = (
  sqlType: string,
): "string" | "int64" | "double" | "decimal" | "dateTime" | "boolean" | undefined => {
  switch (sqlType.toLocaleLowerCase("en-US")) {
    case "bigint":
    case "int":
    case "smallint":
    case "tinyint":
      return "int64";
    case "decimal":
    case "numeric":
    case "money":
    case "smallmoney":
      return "decimal";
    case "float":
    case "real":
      return "double";
    case "bit":
      return "boolean";
    case "date":
    case "datetime":
    case "datetime2":
    case "datetimeoffset":
    case "smalldatetime":
      return "dateTime";
    case "char":
    case "nchar":
    case "nvarchar":
    case "text":
    case "uniqueidentifier":
    case "varchar":
    case "xml":
      return "string";
    default:
      return undefined;
  }
};

const sourceColumnSchema = z.object({
  schemaName: z.string(),
  tableName: z.string(),
  columnName: z.string(),
  ordinalPosition: z.number().int(),
  dataType: z.string(),
});

const extractSourceColumns = (envelope: ToolEnvelope): readonly SourceColumn[] => {
  const parsed = z.array(sourceColumnSchema).safeParse(envelope.data?.["columns"]);
  if (!parsed.success || parsed.data.length === 0) {
    throw new Error("The configured Lakehouse table did not return any SQL schema columns.");
  }
  return parsed.data;
};

const createDirectLakeModel = (
  workspaceId: string,
  lakehouseId: string,
  tableName: string,
  schemaName: string,
  sourceColumns: readonly SourceColumn[],
): ModelSpec => {
  const columns = sourceColumns
    .map((column) => ({ column, dataType: modelDataType(column.dataType) }))
    .filter(
      (
        entry,
      ): entry is {
        readonly column: SourceColumn;
        readonly dataType: NonNullable<ReturnType<typeof modelDataType>>;
      } => entry.dataType !== undefined,
    )
    .slice(0, 100)
    .map(({ column, dataType }) => ({
      kind: "source" as const,
      name: column.columnName,
      sourceColumn: column.columnName,
      dataType,
      hidden: false,
      key: false,
      summarizeBy: "none" as const,
      annotations: [],
    }));
  if (columns.length === 0) {
    throw new Error("The configured Lakehouse table has no supported Direct Lake column types.");
  }

  const expressionName = "DirectLake Source";
  return {
    compatibilityLevel: 1702,
    culture: "en-US",
    defaultPowerBIDataSourceVersion: "powerBI_V3",
    discourageImplicitMeasures: true,
    dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true },
    dataSources: [],
    expressions: [
      {
        name: expressionName,
        kind: "m",
        expression: `let\n    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${workspaceId}/${lakehouseId}", [HierarchicalNavigation=true])\nin\n    Source`,
        description: "Shared OneLake source for Direct Lake entity partitions.",
        annotations: [],
      },
    ],
    relationships: [],
    calculationGroups: [],
    roles: [],
    annotations: [],
    tables: [
      {
        name: tableName,
        description: "Disposable Direct Lake verification table.",
        hidden: false,
        columns,
        partitions: [
          {
            kind: "entity",
            name: tableName,
            mode: "directLake",
            expressionSource: expressionName,
            entityName: tableName,
            schemaName,
            annotations: [],
          },
        ],
        measures: [
          {
            name: "Verification Row Count",
            expression: `COUNTROWS('${tableName.replaceAll("'", "''")}')`,
            description: "Counts rows for the disposable Direct Lake acceptance check.",
            formatString: "#,0",
            hidden: false,
            annotations: [],
          },
        ],
        hierarchies: [],
        annotations: [],
      },
    ],
  };
};

async function main(): Promise<void> {
  if (process.env["LIVE_DIRECT_LAKE_MUTATION"] !== "true") {
    throw new ConfigurationError([
      "LIVE_DIRECT_LAKE_MUTATION must be true for the disposable Direct Lake check.",
    ]);
  }
  if (process.env["LIVE_DIRECT_LAKE_PERMANENT_DELETE"] !== "true") {
    throw new ConfigurationError([
      "LIVE_DIRECT_LAKE_PERMANENT_DELETE must be true because cleanup is irreversible.",
    ]);
  }

  const workspaceId = requireLiveTestWorkspaceId();
  const lakehouseId = uuidSchema.parse(process.env["FABRIC_TEST_LAKEHOUSE_ID"]?.trim());
  const tableName = identifierSchema.parse(process.env["FABRIC_TEST_LAKEHOUSE_TABLE"]?.trim());
  const config = loadConfig();
  if (config.auth.mode !== "api-key") {
    throw new ConfigurationError(["MCP_AUTH_MODE must be api-key for local MCP verification."]);
  }
  const apiKey = config.auth.apiKey;
  if (config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be false for the disposable Direct Lake check.",
    ]);
  }

  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [apiKey, ...(config.azure.clientSecret ? [config.azure.clientSecret] : [])],
  });
  const server = createServer(createHttpApp(config, logger));
  const client = new Client({ name: "direct-lake-live-check", version: "1.0.0" });
  let semanticModelId: string | undefined;
  let displayName = `MCP Direct Lake Verification ${randomUUID().slice(0, 8)}`;
  let connected = false;
  let deleted = false;
  let primaryError: unknown;

  const callRaw = async (name: string, args: Record<string, unknown>): Promise<ToolEnvelope> => {
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: MCP_REQUEST_TIMEOUT_MS },
    );
    return result.structuredContent as ToolEnvelope;
  };
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolEnvelope> => {
    const envelope = await callRaw(name, args);
    if (!envelope.ok) {
      throw new Error(`${name} failed [${envelope.error?.code ?? "UNKNOWN"}]: ${envelope.message}`);
    }
    return envelope;
  };

  try {
    await listen(server);
    const address = server.address() as AddressInfo;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
        authProvider: { token: () => Promise.resolve(apiKey) },
      }),
    );
    connected = true;
    if ((await client.listTools()).tools.length !== TOOL_NAMES.length) {
      throw new Error(`The live MCP server did not advertise exactly ${TOOL_NAMES.length} tools.`);
    }

    const lakehouse = await call("get_lakehouse", { workspaceId, lakehouseId });
    if (lakehouse.data?.["id"] !== lakehouseId) {
      throw new Error("The configured Lakehouse was not resolved through MCP.");
    }
    const schema = await call("inspect_data_source_schema", {
      workspaceId,
      itemType: "lakehouse",
      itemId: lakehouseId,
      tableName,
      maxColumns: 500,
    });
    const sourceColumns = extractSourceColumns(schema);
    const schemaNames = new Set(sourceColumns.map((column) => column.schemaName));
    if (schemaNames.size !== 1) {
      throw new Error("The configured Lakehouse table resolved to more than one SQL schema.");
    }
    const schemaName = [...schemaNames][0]!;
    const model = createDirectLakeModel(
      workspaceId,
      lakehouseId,
      tableName,
      schemaName,
      sourceColumns,
    );

    const gate = await call("pre_deploy_gate", {
      model,
      checks: ["structure", "names", "dax", "relationships", "connections"],
    });
    if (gate.data?.["passed"] !== true) {
      throw new Error("The Direct Lake pre-deployment gate did not pass.");
    }
    const preview = await call("create_semantic_model", {
      workspaceId,
      displayName,
      description: "Disposable Direct Lake production acceptance model.",
      model,
    });
    if (preview.data?.["applied"] !== false) {
      throw new Error("The Direct Lake creation preview was not non-mutating.");
    }
    const created = await call("create_semantic_model", {
      workspaceId,
      displayName,
      description: "Disposable Direct Lake production acceptance model.",
      model,
      apply: true,
    });
    const item = created.data?.["item"];
    const createdId =
      item && typeof item === "object" && !Array.isArray(item) ? item["id"] : undefined;
    if (typeof createdId !== "string") {
      throw new Error("Direct Lake creation did not return a semantic model ID.");
    }
    semanticModelId = createdId;
    const ids = { workspaceId, semanticModelId };

    const definition = await call("get_semantic_model_definition", {
      ...ids,
      includeDefinition: true,
    });
    const readback = definition.data?.["model"] as Record<string, JsonValue> | undefined;
    const tables = readback?.["tables"];
    const expressions = readback?.["expressions"];
    if (!Array.isArray(tables) || !Array.isArray(expressions) || expressions.length !== 1) {
      throw new Error("The Direct Lake definition did not round-trip through Fabric.");
    }
    const modelTable = tables[0];
    const partitions =
      modelTable && typeof modelTable === "object" && !Array.isArray(modelTable)
        ? modelTable["partitions"]
        : undefined;
    const partition = Array.isArray(partitions) ? partitions[0] : undefined;
    if (
      !partition ||
      typeof partition !== "object" ||
      Array.isArray(partition) ||
      partition["kind"] !== "entity" ||
      partition["expressionSource"] !== "DirectLake Source" ||
      Object.hasOwn(partition, "dataSourceName")
    ) {
      throw new Error("Fabric readback did not preserve the Direct Lake expression source.");
    }

    const refresh = await call("refresh_semantic_model", {
      ...ids,
      refreshType: "full",
      apply: true,
    });
    const refreshId = refresh.data?.["refreshId"];
    if (typeof refreshId !== "string") {
      throw new Error("The Direct Lake refresh did not return a tracking ID.");
    }
    const refreshDeadline = Date.now() + REFRESH_TIMEOUT_MS;
    let refreshStatus: ToolEnvelope | undefined;
    while (Date.now() < refreshDeadline) {
      refreshStatus = await call("get_refresh_status", { ...ids, refreshId });
      if (refreshStatus.data?.["terminal"] === true) break;
      await delay(5_000);
    }
    if (refreshStatus?.data?.["terminal"] !== true || refreshStatus.data["succeeded"] !== true) {
      throw new Error("The Direct Lake refresh did not reach a successful terminal state.");
    }

    const dax = await call("execute_dax", {
      ...ids,
      query: 'EVALUATE ROW("Rows", [Verification Row Count])',
      maxRows: 1,
      includeNulls: true,
    });
    if (dax.data?.["returnedRows"] !== 1 || dax.data["truncated"] !== false) {
      throw new Error("The Direct Lake DAX probe did not return one complete row.");
    }
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    if (connected && semanticModelId) {
      try {
        await call("delete_semantic_model", {
          workspaceId,
          semanticModelId,
          confirmSemanticModelId: semanticModelId,
          confirmDisplayName: displayName,
          confirmPermanentDelete: true,
          apply: true,
        });
        deleted = true;
      } catch (cleanupError: unknown) {
        if (!primaryError) primaryError = cleanupError;
      }
    }
    await client.close().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
  }

  if (!deleted && semanticModelId) {
    try {
      const clients = createMicrosoftApiClients(config, logger);
      const service = new SemanticModelService(clients.fabric, {
        lroPollBudgetMs: config.lroPollBudgetMs,
      });
      const current = await clients.fabric.getSemanticModel(workspaceId, semanticModelId);
      displayName = current.displayName;
      await service.deleteSemanticModel({
        workspaceId,
        semanticModelId,
        confirmSemanticModelId: semanticModelId,
        confirmDisplayName: displayName,
        confirmPermanentDelete: true,
        apply: true,
      });
      deleted = true;
    } catch (cleanupError: unknown) {
      if (!primaryError) primaryError = cleanupError;
    }
  }

  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined)
    throw new Error("Direct Lake verification failed.", { cause: primaryError });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      sourceType: "lakehouse",
      directLakeCreationVerified: true,
      expressionSourceReadbackVerified: true,
      refreshVerified: true,
      daxVerified: true,
      permanentDeleteVerified: deleted,
      activeArtifactLeft: !deleted,
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
  logger.error("Live Direct Lake verification failed", { error });
  process.exitCode = 1;
}
