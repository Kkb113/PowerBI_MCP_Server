import { randomUUID } from "node:crypto";
import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { ModelError, type ModelSpec } from "../src/model/index.js";
import { SemanticModelService } from "../src/services/index.js";
import { requireLiveTestWorkspaceId } from "./live-workspace.js";

try {
  process.loadEnvFile();
} catch (error: unknown) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const baseModel: ModelSpec = {
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
      name: "Lifecycle Base",
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
      ],
      partitions: [
        {
          kind: "m",
          name: "Lifecycle Base",
          mode: "import",
          expression: "#table(type table [Key = Int64.Type], {{1}})",
          annotations: [],
        },
      ],
      measures: [],
      hierarchies: [],
      annotations: [],
    },
  ],
};

const createChanges: readonly unknown[] = [
  {
    action: "create",
    target: { objectType: "table", name: "Lifecycle Fact" },
    value: { name: "Lifecycle Fact" },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Lifecycle Fact", name: "Key" },
    value: { kind: "source", name: "Key", sourceColumn: "Key", dataType: "int64", key: true },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Lifecycle Fact", name: "Amount" },
    value: {
      kind: "source",
      name: "Amount",
      sourceColumn: "Amount",
      dataType: "decimal",
      summarizeBy: "sum",
    },
  },
  {
    action: "create",
    target: { objectType: "partition", parentName: "Lifecycle Fact", name: "Lifecycle Fact" },
    value: {
      kind: "m",
      name: "Lifecycle Fact",
      mode: "import",
      expression:
        "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 100.0}, {2, 200.0}})",
    },
  },
  {
    action: "create",
    target: { objectType: "measure", parentName: "Lifecycle Fact", name: "Lifecycle Total" },
    value: {
      name: "Lifecycle Total",
      expression: "SUM('Lifecycle Fact'[Amount])",
      description: "Live lifecycle verification measure.",
      formatString: "#,0.00",
    },
  },
  {
    action: "create",
    target: { objectType: "table", name: "Lifecycle Dimension" },
    value: { name: "Lifecycle Dimension" },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Lifecycle Dimension", name: "Key" },
    value: { kind: "source", name: "Key", sourceColumn: "Key", dataType: "int64", key: true },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Lifecycle Dimension", name: "Label" },
    value: { kind: "source", name: "Label", sourceColumn: "Label", dataType: "string" },
  },
  {
    action: "create",
    target: {
      objectType: "partition",
      parentName: "Lifecycle Dimension",
      name: "Lifecycle Dimension",
    },
    value: {
      kind: "m",
      name: "Lifecycle Dimension",
      mode: "import",
      expression: '#table(type table [Key = Int64.Type, Label = text], {{1, "One"}, {2, "Two"}})',
    },
  },
  {
    action: "create",
    target: {
      objectType: "hierarchy",
      parentName: "Lifecycle Dimension",
      name: "Lifecycle Hierarchy",
    },
    value: {
      name: "Lifecycle Hierarchy",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Label", column: "Label" },
      ],
    },
  },
  {
    action: "create",
    target: { objectType: "relationship", name: "Lifecycle Relationship" },
    value: {
      name: "Lifecycle Relationship",
      fromTable: "Lifecycle Fact",
      fromColumn: "Key",
      toTable: "Lifecycle Dimension",
      toColumn: "Key",
      fromCardinality: "many",
      toCardinality: "one",
    },
  },
  {
    action: "create",
    target: { objectType: "calculation_group", name: "Lifecycle Calculation" },
    value: {
      tableName: "Lifecycle Calculation",
      items: [{ name: "Current", expression: "SELECTEDMEASURE()" }],
    },
  },
  {
    action: "create",
    target: { objectType: "role", name: "Lifecycle Reader" },
    value: {
      name: "Lifecycle Reader",
      tablePermissions: [
        { table: "Lifecycle Dimension", filterExpression: "'Lifecycle Dimension'[Key] > 0" },
      ],
    },
  },
];

const updateChanges: readonly unknown[] = [
  {
    action: "update",
    target: { objectType: "column", parentName: "Lifecycle Fact", name: "Amount" },
    value: {
      kind: "source",
      name: "Amount",
      sourceColumn: "Amount",
      dataType: "decimal",
      description: "Updated live column.",
      formatString: "#,0.00",
      summarizeBy: "sum",
    },
  },
  {
    action: "update",
    target: { objectType: "partition", parentName: "Lifecycle Fact", name: "Lifecycle Fact" },
    value: {
      kind: "m",
      name: "Lifecycle Fact",
      mode: "import",
      expression:
        "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 125.0}, {2, 250.0}})",
    },
  },
  {
    action: "update",
    target: { objectType: "measure", parentName: "Lifecycle Fact", name: "Lifecycle Total" },
    value: {
      name: "Lifecycle Total",
      expression: "COALESCE(SUM('Lifecycle Fact'[Amount]), 0)",
      description: "Updated live lifecycle verification measure.",
      formatString: "$#,0.00",
    },
  },
  {
    action: "update",
    target: {
      objectType: "hierarchy",
      parentName: "Lifecycle Dimension",
      name: "Lifecycle Hierarchy",
    },
    value: {
      name: "Lifecycle Hierarchy",
      description: "Updated live hierarchy.",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Label", column: "Label" },
      ],
    },
  },
  {
    action: "update",
    target: { objectType: "relationship", name: "Lifecycle Relationship" },
    value: {
      name: "Lifecycle Relationship",
      fromTable: "Lifecycle Fact",
      fromColumn: "Key",
      toTable: "Lifecycle Dimension",
      toColumn: "Key",
      fromCardinality: "many",
      toCardinality: "one",
      active: false,
    },
  },
  {
    action: "update",
    target: { objectType: "calculation_group", name: "Lifecycle Calculation" },
    value: {
      tableName: "Lifecycle Calculation",
      description: "Updated live calculation group.",
      precedence: 10,
      items: [{ name: "Current", expression: "SELECTEDMEASURE()", ordinal: 0 }],
    },
  },
  {
    action: "update",
    target: { objectType: "role", name: "Lifecycle Reader" },
    value: {
      name: "Lifecycle Reader",
      description: "Updated live role.",
      tablePermissions: [
        { table: "Lifecycle Dimension", filterExpression: "'Lifecycle Dimension'[Key] >= 1" },
      ],
    },
  },
];

const deleteChanges: readonly unknown[] = [
  { action: "delete", target: { objectType: "role", name: "Lifecycle Reader" } },
  { action: "delete", target: { objectType: "relationship", name: "Lifecycle Relationship" } },
  {
    action: "delete",
    target: {
      objectType: "hierarchy",
      parentName: "Lifecycle Dimension",
      name: "Lifecycle Hierarchy",
    },
  },
  {
    action: "delete",
    target: { objectType: "measure", parentName: "Lifecycle Fact", name: "Lifecycle Total" },
  },
  {
    action: "delete",
    target: { objectType: "partition", parentName: "Lifecycle Fact", name: "Lifecycle Fact" },
  },
  {
    action: "delete",
    target: {
      objectType: "partition",
      parentName: "Lifecycle Dimension",
      name: "Lifecycle Dimension",
    },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Lifecycle Fact", name: "Amount" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Lifecycle Fact", name: "Key" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Lifecycle Dimension", name: "Label" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Lifecycle Dimension", name: "Key" },
  },
  { action: "delete", target: { objectType: "table", name: "Lifecycle Fact" } },
  { action: "delete", target: { objectType: "table", name: "Lifecycle Dimension" } },
  {
    action: "delete",
    target: { objectType: "calculation_group", name: "Lifecycle Calculation" },
  },
];

const requireCompleted = <T extends { readonly status: string }>(
  result: T,
  operation: string,
): T & { readonly status: "completed" } => {
  if (result.status !== "completed") {
    throw new Error(`${operation} did not complete within the configured LRO polling budget.`);
  }
  return result as T & { readonly status: "completed" };
};

async function main(): Promise<void> {
  if (process.env["LIVE_LIFECYCLE_MUTATION"] !== "true") {
    throw new ConfigurationError([
      "LIVE_LIFECYCLE_MUTATION must be true for the disposable lifecycle mutation check.",
    ]);
  }
  if (process.env["LIVE_LIFECYCLE_PERMANENT_DELETE"] !== "true") {
    throw new ConfigurationError([
      "LIVE_LIFECYCLE_PERMANENT_DELETE must be true because semantic models do not support recoverable deletion.",
    ]);
  }
  const config = loadConfig();
  if (config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be false for the disposable lifecycle mutation check.",
    ]);
  }
  const workspaceId = requireLiveTestWorkspaceId();

  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [
      ...(config.auth.mode === "api-key" ? [config.auth.apiKey] : []),
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const clients = createMicrosoftApiClients(config, logger);
  const service = new SemanticModelService(clients.fabric, {
    lroPollBudgetMs: config.lroPollBudgetMs,
  });
  const suffix = `${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const originalName = `MCP Lifecycle Verification ${suffix}`;
  const updatedName = `${originalName} Updated`;
  let semanticModelId: string | undefined;
  let currentName = originalName;
  let deleted = false;
  let primaryError: unknown;
  const evidence: Record<string, unknown> = {
    workspaceId,
    displayName: originalName,
    connectionBinding: "not_applicable_no_external_source",
  };

  try {
    const workspaces = await clients.fabric.listWorkspaces();
    if (!workspaces.some((workspace) => workspace.id.toLowerCase() === workspaceId)) {
      throw new Error(
        "The configured non-production workspace is not visible to the service principal.",
      );
    }
    const preview = await service.createSemanticModel({
      workspaceId,
      displayName: originalName,
      description: "Disposable semantic-model lifecycle validation model.",
      model: baseModel,
    });
    if (preview.status !== "preview")
      throw new Error("Create preview did not remain non-mutating.");

    const createResult = requireCompleted(
      await service.createSemanticModel({
        workspaceId,
        displayName: originalName,
        description: "Disposable semantic-model lifecycle validation model.",
        model: baseModel,
        apply: true,
      }),
      "create_semantic_model",
    );
    if (!("item" in createResult)) throw new Error("Create result did not include the new item.");
    semanticModelId = createResult.item.id;
    evidence["semanticModelId"] = semanticModelId;
    evidence["createVerified"] = true;

    const listed = await clients.fabric.listSemanticModels(workspaceId);
    if (!listed.some((model) => model.id === semanticModelId)) {
      throw new Error("The created semantic model was not returned by list_semantic_models.");
    }
    evidence["listAndGetVerified"] = true;

    await service.updateSemanticModelProperties({
      workspaceId,
      semanticModelId,
      displayName: updatedName,
      description: "Updated disposable semantic-model lifecycle validation model.",
      apply: true,
    });
    currentName = updatedName;
    evidence["propertyUpdateVerified"] = true;

    let snapshot = requireCompleted(
      await service.getSnapshot(workspaceId, semanticModelId),
      "get_semantic_model_definition",
    ).snapshot;
    const createdObjects = requireCompleted(
      await service.applyModelChanges({
        workspaceId,
        semanticModelId,
        expectedDefinitionHash: snapshot.definitionHash,
        operations: createChanges,
        apply: true,
      }),
      "create model objects",
    );
    if (!("definitionHash" in createdObjects)) throw new Error("Create batch was not verified.");

    await service
      .applyModelChanges({
        workspaceId,
        semanticModelId,
        expectedDefinitionHash: snapshot.definitionHash,
        operations: updateChanges,
        apply: true,
      })
      .then(
        () => {
          throw new Error("A stale definition hash was accepted.");
        },
        (error: unknown) => {
          if ((error as { code?: string }).code !== "STALE_DEFINITION_HASH") throw error;
        },
      );
    evidence["staleHashRejected"] = true;

    snapshot = requireCompleted(
      await service.getSnapshot(workspaceId, semanticModelId),
      "read created objects",
    ).snapshot;
    const updatedObjects = requireCompleted(
      await service.applyModelChanges({
        workspaceId,
        semanticModelId,
        expectedDefinitionHash: snapshot.definitionHash,
        operations: updateChanges,
        apply: true,
      }),
      "update model objects",
    );
    if (!("definitionHash" in updatedObjects)) throw new Error("Update batch was not verified.");

    snapshot = requireCompleted(
      await service.getSnapshot(workspaceId, semanticModelId),
      "read updated objects",
    ).snapshot;
    const deletedObjects = requireCompleted(
      await service.applyModelChanges({
        workspaceId,
        semanticModelId,
        expectedDefinitionHash: snapshot.definitionHash,
        operations: deleteChanges,
        apply: true,
      }),
      "delete model objects",
    );
    if (!("definitionHash" in deletedObjects)) throw new Error("Delete batch was not verified.");
    evidence["objectCrudVerified"] = true;
    evidence["definitionReadbackVerified"] = true;
  } catch (error: unknown) {
    primaryError = error;
  } finally {
    if (!semanticModelId) {
      try {
        const models = await clients.fabric.listSemanticModels(workspaceId);
        const created = models.find((model) => model.displayName === originalName);
        if (created) semanticModelId = created.id;
      } catch {
        // Preserve the primary failure; cleanup status is reported below.
      }
    }
    if (semanticModelId && !deleted) {
      try {
        const item = await clients.fabric.getSemanticModel(workspaceId, semanticModelId);
        currentName = item.displayName;
        await service.deleteSemanticModel({
          workspaceId,
          semanticModelId,
          confirmSemanticModelId: semanticModelId,
          confirmDisplayName: currentName,
          confirmPermanentDelete: true,
          apply: true,
        });
        deleted = true;
      } catch (cleanupError: unknown) {
        if (!primaryError) primaryError = cleanupError;
        evidence["cleanupFailed"] = true;
      }
    }
  }

  evidence["permanentDeleteVerified"] = deleted;
  evidence["activeArtifactLeft"] = semanticModelId !== undefined && !deleted;
  if (primaryError instanceof Error) throw primaryError;
  if (primaryError !== undefined) {
    throw new Error("The live semantic-model lifecycle check failed.", { cause: primaryError });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...evidence })}\n`);
}

try {
  await main();
} catch (error: unknown) {
  const logger = createLogger({
    level: "error",
    knownSecrets: [process.env["MCP_API_KEY"] ?? "", process.env["AZURE_CLIENT_SECRET"] ?? ""],
  });
  logger.error("Live semantic-model lifecycle check failed", {
    error: error instanceof ModelError ? error.toJSON() : error,
  });
  process.exitCode = 1;
}
