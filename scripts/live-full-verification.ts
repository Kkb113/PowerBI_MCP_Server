import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig, type AppConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { createLogger, type Logger } from "../src/logging.js";
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

const liveModel: ModelSpec = {
  compatibilityLevel: 1702,
  culture: "en-US",
  defaultPowerBIDataSourceVersion: "powerBI_V3",
  discourageImplicitMeasures: true,
  dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true },
  dataSources: [],
  expressions: [],
  relationships: [],
  calculationGroups: [],
  roles: [],
  annotations: [],
  tables: [
    {
      name: "Verification Data",
      hidden: false,
      columns: [
        {
          kind: "source",
          name: "Key",
          sourceColumn: "Key",
          dataType: "int64",
          hidden: false,
          key: true,
          summarizeBy: "none",
          annotations: [],
        },
        {
          kind: "source",
          name: "Amount",
          sourceColumn: "Amount",
          dataType: "decimal",
          hidden: false,
          key: false,
          summarizeBy: "sum",
          annotations: [],
        },
      ],
      partitions: [
        {
          kind: "m",
          name: "Verification Data",
          mode: "import",
          expression:
            "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 100.0}, {2, 200.0}})",
          annotations: [],
        },
      ],
      measures: [
        {
          name: "Verification Total",
          expression: "SUM('Verification Data'[Amount])",
          description: "Disposable full-verification DAX measure.",
          formatString: "#,0.00",
          hidden: false,
          annotations: [],
        },
      ],
      hierarchies: [],
      annotations: [],
    },
  ],
};

const createChanges = [
  {
    action: "create",
    target: {
      objectType: "measure",
      parentName: "Verification Data",
      name: "Verification Average",
    },
    value: {
      name: "Verification Average",
      expression: "AVERAGE('Verification Data'[Amount])",
      description: "Created by the full production verification gate.",
      formatString: "#,0.00",
    },
  },
  {
    action: "create",
    target: {
      objectType: "hierarchy",
      parentName: "Verification Data",
      name: "Verification Hierarchy",
    },
    value: {
      name: "Verification Hierarchy",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Amount", column: "Amount" },
      ],
    },
  },
] as const;

const updateChanges = [
  {
    action: "update",
    target: {
      objectType: "measure",
      parentName: "Verification Data",
      name: "Verification Average",
    },
    value: {
      name: "Verification Average",
      expression: "COALESCE(AVERAGE('Verification Data'[Amount]), 0)",
      description: "Updated by the full production verification gate.",
      formatString: "$#,0.00",
    },
  },
  {
    action: "update",
    target: {
      objectType: "hierarchy",
      parentName: "Verification Data",
      name: "Verification Hierarchy",
    },
    value: {
      name: "Verification Hierarchy",
      description: "Updated by the full production verification gate.",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Amount", column: "Amount" },
      ],
    },
  },
] as const;

const deleteChanges = [
  {
    action: "delete",
    target: {
      objectType: "hierarchy",
      parentName: "Verification Data",
      name: "Verification Hierarchy",
    },
  },
  {
    action: "delete",
    target: {
      objectType: "measure",
      parentName: "Verification Data",
      name: "Verification Average",
    },
  },
] as const;

interface ToolEnvelope {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly data: Readonly<Record<string, JsonValue>> | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const listen = (server: Server): Promise<void> =>
  new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const parseEnvelope = (value: unknown): ToolEnvelope => value as ToolEnvelope;
const MCP_REQUEST_TIMEOUT_MS = 180_000;

async function runLifecycle(
  run: number,
  config: AppConfig,
  logger: Logger,
  workspaceId: string,
): Promise<Readonly<Record<string, JsonValue>>> {
  const server = createServer(createHttpApp(config, logger));
  const client = new Client({ name: `full-live-check-${run}`, version: "1.0.0" });
  const suffix = `${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const originalName = `MCP Full Verification Run ${run} ${suffix}`;
  const updatedName = `${originalName} Updated`;
  let currentName = originalName;
  let semanticModelId: string | undefined;
  let connected = false;
  let deleted = false;
  let primaryError: unknown;
  const evidence: Record<string, JsonValue> = {
    run,
    connectionBinding: "not_applicable_no_external_source",
  };

  const callRaw = async (name: string, args: Record<string, unknown>): Promise<ToolEnvelope> => {
    const result = await client.callTool(
      { name, arguments: args },
      { timeout: MCP_REQUEST_TIMEOUT_MS },
    );
    return parseEnvelope(result.structuredContent);
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
        authProvider: { token: () => Promise.resolve(config.apiKey) },
      }),
    );
    connected = true;

    if ((await client.listTools()).tools.length !== TOOL_NAMES.length) {
      throw new Error(`The live MCP server did not advertise exactly ${TOOL_NAMES.length} tools.`);
    }
    evidence["mcpContractVerified"] = true;

    const workspaces = await call("list_workspaces", {});
    const visibleWorkspaces = workspaces.data?.["value"];
    if (
      !Array.isArray(visibleWorkspaces) ||
      !visibleWorkspaces.some(
        (workspace) =>
          workspace &&
          typeof workspace === "object" &&
          !Array.isArray(workspace) &&
          workspace["id"] === workspaceId,
      )
    ) {
      throw new Error("The selected non-production workspace was not visible through MCP.");
    }

    const preview = await call("create_semantic_model", {
      workspaceId,
      displayName: originalName,
      description: "Disposable full production-verification model.",
      model: liveModel,
    });
    if (preview.data?.["applied"] !== false) {
      throw new Error("The create preview was not non-mutating.");
    }

    const created = await call("create_semantic_model", {
      workspaceId,
      displayName: originalName,
      description: "Disposable full production-verification model.",
      model: liveModel,
      apply: true,
    });
    if (created.status !== "success") {
      throw new Error("Semantic model creation did not complete within the polling budget.");
    }
    const item = created.data?.["item"];
    const createdId =
      item && typeof item === "object" && !Array.isArray(item) ? item["id"] : undefined;
    if (typeof createdId !== "string") throw new Error("Create did not return a model ID.");
    semanticModelId = createdId;
    const ids = { workspaceId, semanticModelId };
    evidence["createVerified"] = true;

    const listed = await call("list_semantic_models", { workspaceId, limit: 500 });
    const models = listed.data?.["value"];
    if (
      !Array.isArray(models) ||
      !models.some(
        (model) =>
          model &&
          typeof model === "object" &&
          !Array.isArray(model) &&
          model["id"] === semanticModelId,
      )
    ) {
      throw new Error("The created model was not returned by list_semantic_models.");
    }

    await call("update_semantic_model_properties", {
      ...ids,
      displayName: updatedName,
      description: "Updated disposable full production-verification model.",
      apply: true,
    });
    currentName = updatedName;
    const updatedItem = await call("get_semantic_model", ids);
    if (updatedItem.data?.["displayName"] !== updatedName) {
      throw new Error("The semantic model property update was not read back.");
    }
    evidence["propertyUpdateVerified"] = true;

    const initialSnapshot = await call("model_snapshot", ids);
    const initialHash = initialSnapshot.data?.["definitionHash"];
    if (typeof initialHash !== "string") throw new Error("Initial snapshot hash was absent.");

    const createObjects = await call("apply_model_changes", {
      ...ids,
      expectedDefinitionHash: initialHash,
      operations: createChanges,
      apply: true,
    });
    if (createObjects.status !== "success") throw new Error("Object creation did not complete.");

    const staleAttempt = await callRaw("apply_model_changes", {
      ...ids,
      expectedDefinitionHash: initialHash,
      operations: updateChanges,
      apply: true,
    });
    if (staleAttempt.ok || staleAttempt.error?.code !== "STALE_DEFINITION_HASH") {
      throw new Error("A stale concurrent definition hash was not rejected.");
    }
    evidence["staleHashRejected"] = true;

    const createdSnapshot = await call("model_snapshot", ids);
    const createdHash = createdSnapshot.data?.["definitionHash"];
    if (typeof createdHash !== "string") throw new Error("Created-object hash was absent.");
    await call("apply_model_changes", {
      ...ids,
      expectedDefinitionHash: createdHash,
      operations: updateChanges,
      apply: true,
    });

    const updatedSnapshot = await call("model_snapshot", ids);
    const updatedHash = updatedSnapshot.data?.["definitionHash"];
    if (typeof updatedHash !== "string") throw new Error("Updated-object hash was absent.");
    await call("apply_model_changes", {
      ...ids,
      expectedDefinitionHash: updatedHash,
      operations: deleteChanges,
      apply: true,
    });
    evidence["objectCrudVerified"] = true;

    const restoredSnapshot = await call("model_snapshot", ids);
    if (restoredSnapshot.data?.["definitionHash"] !== initialHash) {
      throw new Error("Object CRUD did not restore the original semantic definition hash.");
    }
    const definition = await call("get_semantic_model_definition", ids);
    if (definition.data?.["definitionHash"] !== initialHash) {
      throw new Error("Definition readback hash did not match the restored snapshot.");
    }
    await call("get_model_info", {
      ...ids,
      sections: ["tables", "columns", "measures", "partitions"],
      limitPerSection: 50,
    });
    evidence["definitionReadbackVerified"] = true;

    const diff = await call("model_diff", {
      ...ids,
      proposed: { kind: "model_spec", model: liveModel },
    });
    const diffValue = diff.data?.["diff"];
    if (
      !diffValue ||
      typeof diffValue !== "object" ||
      Array.isArray(diffValue) ||
      diffValue["hasChanges"] !== false
    ) {
      throw new Error("The restored live model differed from the canonical input model.");
    }
    const gate = await call("pre_deploy_gate", {
      ...ids,
      checks: ["structure", "names", "dax", "relationships", "connections"],
    });
    if (gate.data?.["passed"] !== true) throw new Error("The pre-deployment gate did not pass.");
    evidence["diffAndGateVerified"] = true;

    const refreshPreview = await call("refresh_semantic_model", {
      ...ids,
      refreshType: "full",
    });
    if (refreshPreview.data?.["applied"] !== false) {
      throw new Error("The refresh preview was not non-mutating.");
    }
    const refresh = await call("refresh_semantic_model", {
      ...ids,
      refreshType: "full",
      apply: true,
    });
    const refreshId = refresh.data?.["refreshId"];
    if (typeof refreshId !== "string") throw new Error("Refresh tracking ID was absent.");

    const refreshDeadline = Date.now() + 300_000;
    let refreshStatus: ToolEnvelope | undefined;
    while (Date.now() < refreshDeadline) {
      refreshStatus = await call("get_refresh_status", { ...ids, refreshId });
      if (refreshStatus.data?.["terminal"] === true) break;
      await delay(5_000);
    }
    if (refreshStatus?.data?.["terminal"] !== true) {
      throw new Error("Refresh did not reach a terminal state within five minutes.");
    }
    if (refreshStatus.data["succeeded"] !== true) {
      throw new Error("The full refresh reached a failed terminal state.");
    }
    evidence["refreshVerified"] = true;

    const validation = await call("validate_dax", { ...ids, expression: "[Verification Total]" });
    if (validation.data?.["valid"] !== true) throw new Error("Valid DAX was rejected.");
    const invalid = await call("validate_dax", { ...ids, expression: "SUM(" });
    if (invalid.data?.["valid"] !== false) throw new Error("Invalid DAX was accepted.");
    const query = await call("execute_dax", {
      ...ids,
      query: 'EVALUATE ROW("Smoke", [Verification Total])',
      maxRows: 1,
      includeNulls: true,
    });
    if (query.data?.["returnedRows"] !== 1 || query.data["truncated"] !== false) {
      throw new Error("The bounded DAX query did not return one complete row.");
    }
    evidence["daxVerified"] = true;
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    if (connected && semanticModelId) {
      try {
        await call("delete_semantic_model", {
          workspaceId,
          semanticModelId,
          confirmSemanticModelId: semanticModelId,
          confirmDisplayName: currentName,
          confirmPermanentDelete: true,
          apply: true,
        });
        const remaining = await call("list_semantic_models", { workspaceId, limit: 500 });
        const remainingModels = remaining.data?.["value"];
        if (
          Array.isArray(remainingModels) &&
          remainingModels.some(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              !Array.isArray(candidate) &&
              candidate["id"] === semanticModelId,
          )
        ) {
          throw new Error("The disposable semantic model remained after permanent deletion.");
        }
        deleted = true;
      } catch (cleanupError: unknown) {
        if (!primaryError) primaryError = cleanupError;
      }
    }
    await client.close().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
  }

  if (!deleted) {
    try {
      const clients = createMicrosoftApiClients(config, logger);
      if (!semanticModelId) {
        const models = await clients.fabric.listSemanticModels(workspaceId);
        semanticModelId = models.find((candidate) => candidate.displayName === originalName)?.id;
      }
      if (!semanticModelId) throw new Error("No disposable model was found for fallback cleanup.");
      const service = new SemanticModelService(clients.fabric, {
        lroPollBudgetMs: config.lroPollBudgetMs,
      });
      const current = await clients.fabric.getSemanticModel(workspaceId, semanticModelId);
      await service.deleteSemanticModel({
        workspaceId,
        semanticModelId,
        confirmSemanticModelId: semanticModelId,
        confirmDisplayName: current.displayName,
        confirmPermanentDelete: true,
        apply: true,
      });
      deleted = true;
      evidence["fallbackCleanupUsed"] = true;
    } catch (cleanupError: unknown) {
      evidence["cleanupFailed"] = true;
      if (!primaryError) primaryError = cleanupError;
    }
  }

  evidence["permanentDeleteVerified"] = deleted;
  evidence["activeArtifactLeft"] = semanticModelId !== undefined && !deleted;
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined) {
    throw new Error(`Full live verification run ${run} failed.`, { cause: primaryError });
  }
  return evidence;
}

async function main(): Promise<void> {
  if (process.env["LIVE_FULL_MUTATION"] !== "true") {
    throw new ConfigurationError([
      "LIVE_FULL_MUTATION must be true for the disposable full verification check.",
    ]);
  }
  if (process.env["LIVE_FULL_PERMANENT_DELETE"] !== "true") {
    throw new ConfigurationError([
      "LIVE_FULL_PERMANENT_DELETE must be true because cleanup is irreversible.",
    ]);
  }
  const config = loadConfig();
  if (config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be false for the disposable full verification check.",
    ]);
  }
  const workspaceId = requireLiveTestWorkspaceId();

  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [
      config.apiKey,
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const runs: Readonly<Record<string, JsonValue>>[] = [];
  for (let run = 1; run <= 2; run += 1) {
    runs.push(await runLifecycle(run, config, logger, workspaceId));
  }
  process.stdout.write(`${JSON.stringify({ ok: true, completedRuns: runs.length, runs })}\n`);
}

try {
  await main();
} catch (error: unknown) {
  const logger = createLogger({
    level: "error",
    knownSecrets: [process.env["MCP_API_KEY"] ?? "", process.env["AZURE_CLIENT_SECRET"] ?? ""],
  });
  logger.error("Full production verification failed", { error });
  process.exitCode = 1;
}
