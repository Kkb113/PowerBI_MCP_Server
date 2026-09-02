import { randomUUID } from "node:crypto";
import { createMicrosoftApiClients } from "../src/clients/factory.js";
import { ConfigurationError, loadConfig } from "../src/config.js";
import { createLogger } from "../src/logging.js";
import { ModelError, type ModelSpec } from "../src/model/index.js";
import { SemanticModelService } from "../src/services/index.js";

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
      name: "Phase 4 Base",
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
          name: "Phase 4 Base",
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
    target: { objectType: "table", name: "Phase 4 Fact" },
    value: { name: "Phase 4 Fact" },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Phase 4 Fact", name: "Key" },
    value: { kind: "source", name: "Key", sourceColumn: "Key", dataType: "int64", key: true },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Phase 4 Fact", name: "Amount" },
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
    target: { objectType: "partition", parentName: "Phase 4 Fact", name: "Phase 4 Fact" },
    value: {
      kind: "m",
      name: "Phase 4 Fact",
      mode: "import",
      expression:
        "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 100.0}, {2, 200.0}})",
    },
  },
  {
    action: "create",
    target: { objectType: "measure", parentName: "Phase 4 Fact", name: "Phase 4 Total" },
    value: {
      name: "Phase 4 Total",
      expression: "SUM('Phase 4 Fact'[Amount])",
      description: "Live Phase 4 measure.",
      formatString: "#,0.00",
    },
  },
  {
    action: "create",
    target: { objectType: "table", name: "Phase 4 Dimension" },
    value: { name: "Phase 4 Dimension" },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Phase 4 Dimension", name: "Key" },
    value: { kind: "source", name: "Key", sourceColumn: "Key", dataType: "int64", key: true },
  },
  {
    action: "create",
    target: { objectType: "column", parentName: "Phase 4 Dimension", name: "Label" },
    value: { kind: "source", name: "Label", sourceColumn: "Label", dataType: "string" },
  },
  {
    action: "create",
    target: {
      objectType: "partition",
      parentName: "Phase 4 Dimension",
      name: "Phase 4 Dimension",
    },
    value: {
      kind: "m",
      name: "Phase 4 Dimension",
      mode: "import",
      expression: '#table(type table [Key = Int64.Type, Label = text], {{1, "One"}, {2, "Two"}})',
    },
  },
  {
    action: "create",
    target: {
      objectType: "hierarchy",
      parentName: "Phase 4 Dimension",
      name: "Phase 4 Hierarchy",
    },
    value: {
      name: "Phase 4 Hierarchy",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Label", column: "Label" },
      ],
    },
  },
  {
    action: "create",
    target: { objectType: "relationship", name: "Phase 4 Relationship" },
    value: {
      name: "Phase 4 Relationship",
      fromTable: "Phase 4 Fact",
      fromColumn: "Key",
      toTable: "Phase 4 Dimension",
      toColumn: "Key",
      fromCardinality: "many",
      toCardinality: "one",
    },
  },
  {
    action: "create",
    target: { objectType: "calculation_group", name: "Phase 4 Calculation" },
    value: {
      tableName: "Phase 4 Calculation",
      items: [{ name: "Current", expression: "SELECTEDMEASURE()" }],
    },
  },
  {
    action: "create",
    target: { objectType: "role", name: "Phase 4 Reader" },
    value: {
      name: "Phase 4 Reader",
      tablePermissions: [
        { table: "Phase 4 Dimension", filterExpression: "'Phase 4 Dimension'[Key] > 0" },
      ],
    },
  },
];

const updateChanges: readonly unknown[] = [
  {
    action: "update",
    target: { objectType: "column", parentName: "Phase 4 Fact", name: "Amount" },
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
    target: { objectType: "partition", parentName: "Phase 4 Fact", name: "Phase 4 Fact" },
    value: {
      kind: "m",
      name: "Phase 4 Fact",
      mode: "import",
      expression:
        "#table(type table [Key = Int64.Type, Amount = Currency.Type], {{1, 125.0}, {2, 250.0}})",
    },
  },
  {
    action: "update",
    target: { objectType: "measure", parentName: "Phase 4 Fact", name: "Phase 4 Total" },
    value: {
      name: "Phase 4 Total",
      expression: "COALESCE(SUM('Phase 4 Fact'[Amount]), 0)",
      description: "Updated live Phase 4 measure.",
      formatString: "$#,0.00",
    },
  },
  {
    action: "update",
    target: {
      objectType: "hierarchy",
      parentName: "Phase 4 Dimension",
      name: "Phase 4 Hierarchy",
    },
    value: {
      name: "Phase 4 Hierarchy",
      description: "Updated live hierarchy.",
      levels: [
        { name: "Key", column: "Key" },
        { name: "Label", column: "Label" },
      ],
    },
  },
  {
    action: "update",
    target: { objectType: "relationship", name: "Phase 4 Relationship" },
    value: {
      name: "Phase 4 Relationship",
      fromTable: "Phase 4 Fact",
      fromColumn: "Key",
      toTable: "Phase 4 Dimension",
      toColumn: "Key",
      fromCardinality: "many",
      toCardinality: "one",
      active: false,
    },
  },
  {
    action: "update",
    target: { objectType: "calculation_group", name: "Phase 4 Calculation" },
    value: {
      tableName: "Phase 4 Calculation",
      description: "Updated live calculation group.",
      precedence: 10,
      items: [{ name: "Current", expression: "SELECTEDMEASURE()", ordinal: 0 }],
    },
  },
  {
    action: "update",
    target: { objectType: "role", name: "Phase 4 Reader" },
    value: {
      name: "Phase 4 Reader",
      description: "Updated live role.",
      tablePermissions: [
        { table: "Phase 4 Dimension", filterExpression: "'Phase 4 Dimension'[Key] >= 1" },
      ],
    },
  },
];

const deleteChanges: readonly unknown[] = [
  { action: "delete", target: { objectType: "role", name: "Phase 4 Reader" } },
  { action: "delete", target: { objectType: "relationship", name: "Phase 4 Relationship" } },
  {
    action: "delete",
    target: {
      objectType: "hierarchy",
      parentName: "Phase 4 Dimension",
      name: "Phase 4 Hierarchy",
    },
  },
  {
    action: "delete",
    target: { objectType: "measure", parentName: "Phase 4 Fact", name: "Phase 4 Total" },
  },
  {
    action: "delete",
    target: { objectType: "partition", parentName: "Phase 4 Fact", name: "Phase 4 Fact" },
  },
  {
    action: "delete",
    target: {
      objectType: "partition",
      parentName: "Phase 4 Dimension",
      name: "Phase 4 Dimension",
    },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Phase 4 Fact", name: "Amount" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Phase 4 Fact", name: "Key" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Phase 4 Dimension", name: "Label" },
  },
  {
    action: "delete",
    target: { objectType: "column", parentName: "Phase 4 Dimension", name: "Key" },
  },
  { action: "delete", target: { objectType: "table", name: "Phase 4 Fact" } },
  { action: "delete", target: { objectType: "table", name: "Phase 4 Dimension" } },
  {
    action: "delete",
    target: { objectType: "calculation_group", name: "Phase 4 Calculation" },
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
  if (process.env["PHASE4_LIVE_MUTATION"] !== "true") {
    throw new ConfigurationError([
      "PHASE4_LIVE_MUTATION must be true for the disposable Phase 4 live mutation check.",
    ]);
  }
  if (process.env["PHASE4_LIVE_PERMANENT_DELETE"] !== "true") {
    throw new ConfigurationError([
      "PHASE4_LIVE_PERMANENT_DELETE must be true because semantic models do not support recoverable deletion.",
    ]);
  }
  const config = loadConfig();
  if (config.readOnly) {
    throw new ConfigurationError([
      "POWERBI_MCP_READONLY must be false for the disposable Phase 4 live mutation check.",
    ]);
  }
  if (config.allowedWorkspaceIds.length !== 1) {
    throw new ConfigurationError([
      "FABRIC_ALLOWED_WORKSPACE_IDS must contain exactly one development workspace for the Phase 4 live mutation check.",
    ]);
  }

  const logger = createLogger({
    level: config.logLevel,
    knownSecrets: [
      config.apiKey,
      ...(config.azure.clientSecret ? [config.azure.clientSecret] : []),
    ],
  });
  const clients = createMicrosoftApiClients(config, logger);
  const service = new SemanticModelService(clients.fabric, {
    lroPollBudgetMs: config.lroPollBudgetMs,
  });
  const workspaceId = config.allowedWorkspaceIds[0]!;
  const suffix = `${new Date().toISOString().replaceAll(/[-:.TZ]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const originalName = `MCP Phase 4 ${suffix}`;
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
        "The configured development workspace is not visible to the service principal.",
      );
    }
    const preview = await service.createSemanticModel({
      workspaceId,
      displayName: originalName,
      description: "Disposable Phase 4 lifecycle validation model.",
      model: baseModel,
    });
    if (preview.status !== "preview")
      throw new Error("Create preview did not remain non-mutating.");

    const createResult = requireCompleted(
      await service.createSemanticModel({
        workspaceId,
        displayName: originalName,
        description: "Disposable Phase 4 lifecycle validation model.",
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
      description: "Updated disposable Phase 4 lifecycle validation model.",
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
    throw new Error("The Phase 4 live lifecycle check failed.", { cause: primaryError });
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
  logger.error("Phase 4 live lifecycle check failed", {
    error: error instanceof ModelError ? error.toJSON() : error,
  });
  process.exitCode = 1;
}
