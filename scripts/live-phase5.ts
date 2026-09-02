import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";
import { createLogger } from "../src/logging.js";
import type { JsonValue } from "../src/mcp/schemas.js";
import type { ModelSpec } from "../src/model/index.js";
import { SemanticModelService } from "../src/services/semantic-model-service.js";

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
      name: "Phase 5 Data",
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
          name: "Phase 5 Data",
          mode: "import",
          expression:
            "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 100.0}, {2, 200.0}})",
          annotations: [],
        },
      ],
      measures: [
        {
          name: "Phase 5 Total",
          expression: "SUM('Phase 5 Data'[Amount])",
          description: "Disposable Phase 5 DAX smoke measure.",
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

interface ToolEnvelope {
  readonly ok: boolean;
  readonly status: string;
  readonly message: string;
  readonly data: Readonly<Record<string, JsonValue>> | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

const parseEnvelope = (value: unknown): ToolEnvelope => value as ToolEnvelope;

async function main(): Promise<void> {
  if (process.env["PHASE5_LIVE_MUTATION"] !== "true") {
    throw new ConfigurationError([
      "PHASE5_LIVE_MUTATION must be true for the disposable Phase 5 live check.",
    ]);
  }
  if (process.env["PHASE5_LIVE_PERMANENT_DELETE"] !== "true") {
    throw new ConfigurationError([
      "PHASE5_LIVE_PERMANENT_DELETE must be true because cleanup is irreversible.",
    ]);
  }
  const config = loadConfig();
  if (config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be false for the disposable Phase 5 live check.",
    ]);
  }
  if (config.allowedWorkspaceIds.length !== 1) {
    throw new ConfigurationError([
      "FABRIC_ALLOWED_WORKSPACE_IDS must contain exactly one development workspace.",
    ]);
  }

  const knownSecrets = [
    config.apiKey,
    ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
  ];
  const logger = createLogger({ level: config.logLevel, knownSecrets });
  const server = createServer(createHttpApp(config, logger));
  const client = new Client({ name: "phase-five-live-check", version: "1.0.0" });
  const workspaceId = config.allowedWorkspaceIds[0]!;
  const suffix = `${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const displayName = `MCP Phase 5 ${suffix}`;
  let semanticModelId: string | undefined;
  let connected = false;
  let primaryError: unknown;
  const evidence: Record<string, unknown> = { workspaceId, displayName };

  const call = async (name: string, args: Record<string, unknown>): Promise<ToolEnvelope> => {
    const result = await client.callTool({ name, arguments: args });
    const envelope = parseEnvelope(result.structuredContent);
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

    const listed = await client.listTools();
    evidence["mcpToolCount"] = listed.tools.length;
    const preview = await call("create_semantic_model", {
      workspaceId,
      displayName,
      description: "Disposable Phase 5 workflow validation model.",
      model: liveModel,
    });
    if (preview.data?.["applied"] !== false)
      throw new Error("Create preview was not non-mutating.");

    const created = await call("create_semantic_model", {
      workspaceId,
      displayName,
      description: "Disposable Phase 5 workflow validation model.",
      model: liveModel,
      apply: true,
    });
    if (created.status !== "success") {
      throw new Error("Semantic model creation did not complete within the polling budget.");
    }
    const createdItem = created.data?.["item"];
    if (!createdItem || typeof createdItem !== "object" || Array.isArray(createdItem)) {
      throw new Error("Create result did not include the semantic model item.");
    }
    const createdId = createdItem["id"];
    if (typeof createdId !== "string") throw new Error("Create result did not include a model ID.");
    semanticModelId = createdId;
    evidence["semanticModelId"] = semanticModelId;
    evidence["createViaMcpVerified"] = true;

    const ids = { workspaceId, semanticModelId };
    const snapshot = await call("model_snapshot", ids);
    const definitionHash = snapshot.data?.["definitionHash"];
    if (typeof definitionHash !== "string") throw new Error("Snapshot hash was not returned.");
    evidence["snapshotVerified"] = true;

    const gate = await call("pre_deploy_gate", {
      ...ids,
      checks: ["structure", "dax", "connections"],
    });
    if (gate.data?.["passed"] !== true) throw new Error("The pre-deployment gate did not pass.");
    evidence["preDeployGateVerified"] = true;

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
      throw new Error("The live model and submitted model did not produce an empty diff.");
    }
    evidence["diffVerified"] = true;

    const refresh = await call("refresh_semantic_model", {
      ...ids,
      refreshType: "full",
      apply: true,
    });
    const refreshId = refresh.data?.["refreshId"];
    if (typeof refreshId !== "string") throw new Error("Refresh tracking ID was not returned.");
    evidence["refreshId"] = refreshId;

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
    evidence["refreshStatus"] = refreshStatus.data["status"];
    evidence["refreshSucceeded"] = refreshStatus.data["succeeded"];
    if (refreshStatus.data["succeeded"] !== true) {
      evidence["refreshDiagnostics"] = refreshStatus.data["diagnostics"];
      throw new Error("The disposable model refresh reached a failed terminal state.");
    }

    const validation = await call("validate_dax", { ...ids, expression: "[Phase 5 Total]" });
    if (validation.data?.["valid"] !== true) throw new Error("Valid DAX did not pass validation.");
    const invalid = await call("validate_dax", { ...ids, expression: "SUM(" });
    if (invalid.data?.["valid"] !== false) throw new Error("Invalid DAX was not rejected.");
    evidence["daxValidationVerified"] = true;

    const query = await call("execute_dax", {
      ...ids,
      query: 'EVALUATE ROW("Smoke", [Phase 5 Total])',
      maxRows: 1,
      includeNulls: true,
    });
    if (query.data?.["returnedRows"] !== 1 || query.data["truncated"] !== false) {
      throw new Error("The bounded DAX smoke query did not return exactly one complete row.");
    }
    evidence["daxQueryVerified"] = true;
    evidence["definitionHash"] = definitionHash;
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
          throw new Error(
            "The disposable semantic model was still listed after permanent deletion.",
          );
        }
        evidence["permanentDeleteVerified"] = true;
      } catch (cleanupError: unknown) {
        evidence["permanentDeleteVerified"] = false;
        if (!primaryError) primaryError = cleanupError;
      }
    }
    await client.close().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
  }

  if (evidence["permanentDeleteVerified"] !== true) {
    try {
      const clients = createMicrosoftApiClients(config, logger);
      if (!semanticModelId) {
        const models = await clients.fabric.listSemanticModels(workspaceId);
        semanticModelId = models.find((candidate) => candidate.displayName === displayName)?.id;
      }
      if (!semanticModelId) {
        throw new Error("No disposable semantic model was found for fallback cleanup.");
      }
      const fallback = new SemanticModelService(clients.fabric, {
        lroPollBudgetMs: config.lroPollBudgetMs,
      });
      const current = await clients.fabric.getSemanticModel(workspaceId, semanticModelId);
      await fallback.deleteSemanticModel({
        workspaceId,
        semanticModelId,
        confirmSemanticModelId: semanticModelId,
        confirmDisplayName: current.displayName,
        confirmPermanentDelete: true,
        apply: true,
      });
      evidence["permanentDeleteVerified"] = true;
      evidence["fallbackCleanupUsed"] = true;
    } catch (cleanupError: unknown) {
      evidence["cleanupFailed"] = true;
      if (!primaryError) primaryError = cleanupError;
    }
  }

  evidence["activeArtifactLeft"] =
    semanticModelId !== undefined && evidence["permanentDeleteVerified"] !== true;
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined)
    throw new Error("The Phase 5 live check failed.", { cause: primaryError });
  process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
}

try {
  await main();
} catch (error: unknown) {
  const logger = createLogger({
    level: "error",
    knownSecrets: [process.env["MCP_API_KEY"] ?? "", process.env["AZURE_CLIENT_SECRET"] ?? ""],
  });
  logger.error("Phase 5 live MCP workflow check failed", { error });
  process.exitCode = 1;
}
