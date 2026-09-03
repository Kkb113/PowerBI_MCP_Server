import { z } from "zod";
import type {
  AcceptedOperation,
  FabricClient,
  FabricOperation,
  UpdateSemanticModelRequest,
} from "../clients/fabric-client.js";
import {
  semanticModelDefinitionResponseSchema,
  semanticModelSchema,
  type Connection,
  type SemanticModel,
  type SemanticModelDefinition,
  type Workspace,
} from "../clients/schemas.js";
import { DomainError } from "../errors.js";
import {
  applyModelChanges as mutateModel,
  buildTmslDefinition,
  hashModelSpec,
  normalizeModelSpec,
  parseTmslDefinition,
  type DefinitionPbism,
  type ModelSpec,
  type ModelTransactionResult,
} from "../model/index.js";
import { paginateValues, type Page } from "./pagination.js";

const DEFAULT_SUMMARY_LIMIT = 200;
const MAX_SUMMARY_LIMIT = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const uuidSchema = z.uuid();
const itemNameSchema = z.string().trim().min(1).max(256);
const itemDescriptionSchema = z.string().max(256);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u, "must be a lowercase SHA-256 hash");
const summarySectionSchema = z.enum([
  "tables",
  "columns",
  "partitions",
  "measures",
  "relationships",
  "hierarchies",
  "calculation_groups",
  "roles",
  "dataSources",
  "expressions",
]);

export type ModelInfoSection = z.infer<typeof summarySectionSchema>;

export type SemanticModelFabricClient = Pick<
  FabricClient,
  | "listWorkspaces"
  | "listSemanticModels"
  | "getSemanticModel"
  | "getConnection"
  | "createSemanticModel"
  | "updateSemanticModel"
  | "permanentlyDeleteSemanticModel"
  | "getSemanticModelDefinition"
  | "updateSemanticModelDefinition"
  | "bindSemanticModelConnection"
  | "getOperationState"
  | "getOperationResult"
>;

export interface SemanticModelServiceOptions {
  readonly lroPollBudgetMs: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface PendingOperation {
  readonly operationId: string;
  readonly operationStatus: string;
  readonly retryAfterMs: number;
}

export interface ModelCounts {
  readonly tables: number;
  readonly columns: number;
  readonly partitions: number;
  readonly measures: number;
  readonly relationships: number;
  readonly hierarchies: number;
  readonly calculationGroups: number;
  readonly calculationItems: number;
  readonly roles: number;
  readonly dataSources: number;
  readonly expressions: number;
}

interface BoundedSection<T> {
  readonly value: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface ModelSummary {
  readonly definitionHash: string;
  readonly counts: ModelCounts;
  readonly tables?: BoundedSection<{
    readonly name: string;
    readonly columnCount: number;
    readonly partitionCount: number;
    readonly measureCount: number;
    readonly hierarchyCount: number;
  }>;
  readonly columns?: BoundedSection<{
    readonly table: string;
    readonly name: string;
    readonly kind: string;
    readonly dataType: string;
  }>;
  readonly partitions?: BoundedSection<{
    readonly table: string;
    readonly name: string;
    readonly kind: string;
    readonly mode: string;
  }>;
  readonly measures?: BoundedSection<{ readonly table: string; readonly name: string }>;
  readonly relationships?: BoundedSection<{
    readonly name: string;
    readonly from: string;
    readonly to: string;
    readonly active: boolean;
  }>;
  readonly hierarchies?: BoundedSection<{
    readonly table: string;
    readonly name: string;
    readonly levels: readonly string[];
  }>;
  readonly calculationGroups?: BoundedSection<{
    readonly tableName: string;
    readonly itemCount: number;
  }>;
  readonly roles?: BoundedSection<{ readonly name: string; readonly tablePermissionCount: number }>;
  readonly dataSources?: BoundedSection<{
    readonly name: string;
    readonly protocol: string;
  }>;
  readonly expressions?: BoundedSection<{ readonly name: string; readonly kind: string }>;
}

export interface ModelSnapshot {
  readonly item: SemanticModel;
  readonly definition: SemanticModelDefinition;
  readonly model: ModelSpec;
  readonly definitionProperties: DefinitionPbism;
  readonly additionalParts: readonly SemanticModelDefinition["parts"][number][];
  readonly definitionHash: string;
  readonly summary: ModelSummary;
}

export type SnapshotResult =
  | { readonly status: "completed"; readonly snapshot: ModelSnapshot }
  | {
      readonly status: "pending";
      readonly stage: "read_definition";
      readonly pending: PendingOperation;
    };

export interface CreateSemanticModelInput {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly description?: string;
  readonly model: unknown;
  readonly apply?: boolean;
}

export interface UpdateSemanticModelPropertiesInput {
  readonly workspaceId: string;
  readonly semanticModelId: string;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly apply?: boolean;
}

export interface ApplyModelChangesInput {
  readonly workspaceId: string;
  readonly semanticModelId: string;
  readonly expectedDefinitionHash: string;
  readonly operations: readonly unknown[];
  readonly apply?: boolean;
}

export interface DeleteSemanticModelInput {
  readonly workspaceId: string;
  readonly semanticModelId: string;
  readonly confirmSemanticModelId: string;
  readonly confirmDisplayName: string;
  readonly confirmPermanentDelete: true;
  readonly apply?: boolean;
}

export interface BindSemanticModelConnectionInput {
  readonly workspaceId: string;
  readonly semanticModelId: string;
  readonly sourceName: string;
  readonly connectionId: string;
  readonly apply?: boolean;
}

type PollResult =
  | { readonly status: "succeeded" }
  | { readonly status: "pending"; readonly pending: PendingOperation };

const parseInput = <T>(schema: z.ZodType<T>, input: unknown, operation: string): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "input";
    throw new DomainError(
      "INVALID_REQUEST",
      `${operation} input is invalid at '${path}': ${issue?.message ?? "validation failed"}.`,
    );
  }
  return parsed.data;
};

const bounded = <T>(value: readonly T[], limit: number): BoundedSection<T> => ({
  value: value.slice(0, limit),
  total: value.length,
  truncated: value.length > limit,
});

const countsFor = (model: ModelSpec): ModelCounts => ({
  tables: model.tables.length,
  columns: model.tables.reduce((count, table) => count + table.columns.length, 0),
  partitions: model.tables.reduce((count, table) => count + table.partitions.length, 0),
  measures: model.tables.reduce((count, table) => count + table.measures.length, 0),
  relationships: model.relationships.length,
  hierarchies: model.tables.reduce((count, table) => count + table.hierarchies.length, 0),
  calculationGroups: model.calculationGroups.length,
  calculationItems: model.calculationGroups.reduce((count, group) => count + group.items.length, 0),
  roles: model.roles.length,
  dataSources: model.dataSources.length,
  expressions: model.expressions.length,
});

const allSummarySections: readonly ModelInfoSection[] = summarySectionSchema.options;

export function summarizeModel(
  modelInput: unknown,
  options: { readonly sections?: readonly ModelInfoSection[]; readonly limit?: number } = {},
): ModelSummary {
  const model = normalizeModelSpec(modelInput);
  const sections = new Set(options.sections ?? allSummarySections);
  const limit = z
    .number()
    .int()
    .min(1)
    .max(MAX_SUMMARY_LIMIT)
    .parse(options.limit ?? DEFAULT_SUMMARY_LIMIT);
  const tables = model.tables.map((table) => ({
    name: table.name,
    columnCount: table.columns.length,
    partitionCount: table.partitions.length,
    measureCount: table.measures.length,
    hierarchyCount: table.hierarchies.length,
  }));
  const columns = model.tables.flatMap((table) =>
    table.columns.map((column) => ({
      table: table.name,
      name: column.name,
      kind: column.kind,
      dataType: column.dataType,
    })),
  );
  const partitions = model.tables.flatMap((table) =>
    table.partitions.map((partition) => ({
      table: table.name,
      name: partition.name,
      kind: partition.kind,
      mode: partition.mode,
    })),
  );
  const measures = model.tables.flatMap((table) =>
    table.measures.map((measure) => ({ table: table.name, name: measure.name })),
  );
  const relationships = model.relationships.map((relationship) => ({
    name: relationship.name,
    from: `${relationship.fromTable}[${relationship.fromColumn}]`,
    to: `${relationship.toTable}[${relationship.toColumn}]`,
    active: relationship.active,
  }));
  const hierarchies = model.tables.flatMap((table) =>
    table.hierarchies.map((hierarchy) => ({
      table: table.name,
      name: hierarchy.name,
      levels: hierarchy.levels.map((level) => level.name),
    })),
  );
  const calculationGroups = model.calculationGroups.map((group) => ({
    tableName: group.tableName,
    itemCount: group.items.length,
  }));
  const roles = model.roles.map((role) => ({
    name: role.name,
    tablePermissionCount: role.tablePermissions.length,
  }));
  const dataSources = model.dataSources.map((source) => ({
    name: source.name,
    protocol: source.connectionDetails.protocol,
  }));
  const expressions = model.expressions.map((expression) => ({
    name: expression.name,
    kind: expression.kind,
  }));

  return {
    definitionHash: hashModelSpec(model),
    counts: countsFor(model),
    ...(sections.has("tables") ? { tables: bounded(tables, limit) } : {}),
    ...(sections.has("columns") ? { columns: bounded(columns, limit) } : {}),
    ...(sections.has("partitions") ? { partitions: bounded(partitions, limit) } : {}),
    ...(sections.has("measures") ? { measures: bounded(measures, limit) } : {}),
    ...(sections.has("relationships") ? { relationships: bounded(relationships, limit) } : {}),
    ...(sections.has("hierarchies") ? { hierarchies: bounded(hierarchies, limit) } : {}),
    ...(sections.has("calculation_groups")
      ? { calculationGroups: bounded(calculationGroups, limit) }
      : {}),
    ...(sections.has("roles") ? { roles: bounded(roles, limit) } : {}),
    ...(sections.has("dataSources") ? { dataSources: bounded(dataSources, limit) } : {}),
    ...(sections.has("expressions") ? { expressions: bounded(expressions, limit) } : {}),
  };
}

const createInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  displayName: itemNameSchema,
  description: itemDescriptionSchema.optional(),
  model: z.unknown(),
  apply: z.boolean().default(false),
});

const updatePropertiesInputSchema = z
  .strictObject({
    workspaceId: uuidSchema,
    semanticModelId: uuidSchema,
    displayName: itemNameSchema.optional(),
    description: itemDescriptionSchema.nullable().optional(),
    apply: z.boolean().default(false),
  })
  .refine((input) => input.displayName !== undefined || input.description !== undefined, {
    message: "At least one property must be supplied.",
  });

const applyChangesInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  semanticModelId: uuidSchema,
  expectedDefinitionHash: hashSchema,
  operations: z.array(z.unknown()).min(1).max(500),
  apply: z.boolean().default(false),
});

const deleteInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  semanticModelId: uuidSchema,
  confirmSemanticModelId: uuidSchema,
  confirmDisplayName: itemNameSchema,
  confirmPermanentDelete: z.literal(true),
  apply: z.boolean().default(false),
});

const bindInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  semanticModelId: uuidSchema,
  sourceName: itemNameSchema,
  connectionId: uuidSchema,
  apply: z.boolean().default(false),
});

const sameName = (left: string, right: string): boolean =>
  left.localeCompare(right, "en-US", { sensitivity: "base" }) === 0;

const stringAddress = (
  address: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
): string | undefined => {
  const value = address[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

const sourceConnectionDetails = (
  source: ModelSpec["dataSources"][number],
): Connection["connectionDetails"] => {
  const protocol = source.connectionDetails.protocol.toLocaleLowerCase("en-US");
  const address = source.connectionDetails.address;
  const explicitType = stringAddress(address, "type");
  const explicitPath = stringAddress(address, "path");
  if (explicitType && explicitPath) {
    return { type: explicitType, path: explicitPath };
  }
  if (protocol === "tds") {
    const server = stringAddress(address, "server");
    const database = stringAddress(address, "database");
    if (server && database) {
      return { type: "SQL", path: `${server};${database}` };
    }
  }
  if (protocol === "http" || protocol === "https" || protocol === "web") {
    const url = stringAddress(address, "url");
    if (url) {
      return { type: "Web", path: url };
    }
  }
  throw new DomainError(
    "UNSUPPORTED_CONNECTION_REFERENCE",
    `Data source '${source.name}' cannot be mapped safely to Fabric connection type and path metadata.`,
  );
};

const sameConnectionDetails = (
  expected: Connection["connectionDetails"],
  actual: Connection["connectionDetails"],
): boolean => {
  if (!sameName(expected.type, actual.type)) return false;
  if (expected.type.toLocaleLowerCase("en-US") === "sql") {
    return sameName(expected.path, actual.path);
  }
  return expected.path === actual.path;
};

const completedSnapshot = (
  item: SemanticModel,
  definition: SemanticModelDefinition,
): ModelSnapshot => {
  const parsed = parseTmslDefinition(definition);
  const definitionHash = hashModelSpec(parsed.model);
  return {
    item,
    definition,
    model: parsed.model,
    definitionProperties: parsed.definitionProperties,
    additionalParts: parsed.additionalParts,
    definitionHash,
    summary: summarizeModel(parsed.model),
  };
};

const countsMatch = (left: ModelCounts, right: ModelCounts): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export class SemanticModelService {
  private readonly lroPollBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly fabric: SemanticModelFabricClient,
    options: SemanticModelServiceOptions,
  ) {
    this.lroPollBudgetMs = z.number().int().min(0).max(600_000).parse(options.lroPollBudgetMs);
    this.pollIntervalMs = z
      .number()
      .int()
      .min(1)
      .max(60_000)
      .parse(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      (async (milliseconds) => {
        await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
      });
  }

  public async listWorkspaces(input: unknown = {}): Promise<Page<Workspace>> {
    const workspaces = await this.fabric.listWorkspaces();
    return paginateValues(workspaces, "workspaces", input);
  }

  public async listSemanticModels(
    workspaceId: string,
    input: unknown = {},
  ): Promise<Page<SemanticModel>> {
    const validWorkspaceId = parseInput(uuidSchema, workspaceId, "list_semantic_models");
    const semanticModels = await this.fabric.listSemanticModels(validWorkspaceId);
    return paginateValues(semanticModels, `semanticModels:${validWorkspaceId}`, input);
  }

  public async getSemanticModel(
    workspaceId: string,
    semanticModelId: string,
  ): Promise<SemanticModel> {
    return await this.fabric.getSemanticModel(
      parseInput(uuidSchema, workspaceId, "get_semantic_model"),
      parseInput(uuidSchema, semanticModelId, "get_semantic_model"),
    );
  }

  public async getSnapshot(workspaceId: string, semanticModelId: string): Promise<SnapshotResult> {
    const validWorkspaceId = parseInput(uuidSchema, workspaceId, "get_semantic_model_definition");
    const validSemanticModelId = parseInput(
      uuidSchema,
      semanticModelId,
      "get_semantic_model_definition",
    );
    const [item, operation] = await Promise.all([
      this.fabric.getSemanticModel(validWorkspaceId, validSemanticModelId),
      this.fabric.getSemanticModelDefinition(validWorkspaceId, validSemanticModelId),
    ]);
    const definition = await this.resolveDefinition(operation);
    if (definition.status === "pending") {
      return { status: "pending", stage: "read_definition", pending: definition.pending };
    }
    return { status: "completed", snapshot: completedSnapshot(item, definition.data) };
  }

  public async getModelInfo(
    workspaceId: string,
    semanticModelId: string,
    options: {
      readonly sections?: readonly ModelInfoSection[];
      readonly limitPerSection?: number;
    } = {},
  ): Promise<SnapshotResult | { readonly status: "completed"; readonly summary: ModelSummary }> {
    const sections = options.sections
      ? z.array(summarySectionSchema).min(1).max(allSummarySections.length).parse(options.sections)
      : undefined;
    const result = await this.getSnapshot(workspaceId, semanticModelId);
    if (result.status === "pending") return result;
    return {
      status: "completed",
      summary: summarizeModel(result.snapshot.model, {
        ...(sections === undefined ? {} : { sections }),
        ...(options.limitPerSection === undefined ? {} : { limit: options.limitPerSection }),
      }),
    };
  }

  public async createSemanticModel(input: CreateSemanticModelInput) {
    const parsed = parseInput(createInputSchema, input, "create_semantic_model");
    const model = normalizeModelSpec(parsed.model);
    const definition = buildTmslDefinition(model);
    const summary = summarizeModel(model);

    if (!parsed.apply) {
      return {
        status: "preview" as const,
        stage: "create" as const,
        applied: false,
        displayName: parsed.displayName,
        definitionHash: summary.definitionHash,
        summary,
      };
    }

    const operation = await this.fabric.createSemanticModel(parsed.workspaceId, {
      displayName: parsed.displayName,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      definition,
    });
    const created = await this.resolveCreate(operation);
    if (created.status === "pending") {
      return {
        status: "pending" as const,
        stage: "create" as const,
        applied: true,
        definitionHash: summary.definitionHash,
        pending: created.pending,
      };
    }
    const readBack = await this.getSnapshot(parsed.workspaceId, created.data.id);
    if (readBack.status === "pending") {
      return {
        status: "pending" as const,
        stage: "readback" as const,
        applied: true,
        item: created.data,
        definitionHash: summary.definitionHash,
        pending: readBack.pending,
      };
    }
    this.verifyReadBack(summary, readBack.snapshot);
    return {
      status: "completed" as const,
      stage: "create" as const,
      applied: true,
      item: readBack.snapshot.item,
      definitionHash: readBack.snapshot.definitionHash,
      summary: readBack.snapshot.summary,
    };
  }

  public async updateSemanticModelProperties(input: UpdateSemanticModelPropertiesInput) {
    const parsed = parseInput(
      updatePropertiesInputSchema,
      input,
      "update_semantic_model_properties",
    );
    const current = await this.fabric.getSemanticModel(parsed.workspaceId, parsed.semanticModelId);
    const request: UpdateSemanticModelRequest = {
      ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
      ...(parsed.description === undefined ? {} : { description: parsed.description ?? "" }),
    };
    const displayName = request.displayName ?? current.displayName;
    const description = request.description ?? current.description;
    const hasChanges =
      displayName !== current.displayName || (description ?? "") !== (current.description ?? "");

    if (!parsed.apply) {
      return {
        status: "preview" as const,
        stage: "update_properties" as const,
        applied: false,
        hasChanges,
        before: current,
        after: { ...current, displayName, ...(description === undefined ? {} : { description }) },
      };
    }
    if (hasChanges) {
      await this.fabric.updateSemanticModel(parsed.workspaceId, parsed.semanticModelId, request);
    }
    const readBack = await this.fabric.getSemanticModel(parsed.workspaceId, parsed.semanticModelId);
    if (
      readBack.displayName !== displayName ||
      (readBack.description ?? "") !== (description ?? "")
    ) {
      throw new DomainError(
        "PROPERTY_READBACK_MISMATCH",
        "Fabric semantic model properties did not match the submitted update.",
      );
    }
    return {
      status: "completed" as const,
      stage: "update_properties" as const,
      applied: hasChanges,
      item: readBack,
    };
  }

  public async applyModelChanges(input: ApplyModelChangesInput) {
    const parsed = parseInput(applyChangesInputSchema, input, "apply_model_changes");
    const current = await this.getSnapshot(parsed.workspaceId, parsed.semanticModelId);
    if (current.status === "pending") {
      return { ...current, applied: false };
    }
    if (current.snapshot.definitionHash !== parsed.expectedDefinitionHash) {
      throw new DomainError(
        "STALE_DEFINITION_HASH",
        "The semantic model definition changed after it was read; fetch a new snapshot before applying changes.",
      );
    }
    const transaction = mutateModel(current.snapshot.model, parsed.operations);
    const definition = buildTmslDefinition(
      transaction.model,
      current.snapshot.definitionProperties,
      current.snapshot.additionalParts,
    );

    if (!parsed.apply) {
      return {
        status: "preview" as const,
        stage: "update_definition" as const,
        applied: false,
        transaction,
        summary: summarizeModel(transaction.model),
      };
    }
    if (!transaction.diff.hasChanges) {
      return {
        status: "completed" as const,
        stage: "update_definition" as const,
        applied: false,
        transaction,
        summary: current.snapshot.summary,
      };
    }
    const operation = await this.fabric.updateSemanticModelDefinition(
      parsed.workspaceId,
      parsed.semanticModelId,
      definition,
      true,
    );
    const updated = await this.resolveUpdate(operation);
    if (updated.status === "pending") {
      return {
        status: "pending" as const,
        stage: "update_definition" as const,
        applied: true,
        transaction,
        pending: updated.pending,
      };
    }
    const readBack = await this.getSnapshot(parsed.workspaceId, parsed.semanticModelId);
    if (readBack.status === "pending") {
      return {
        status: "pending" as const,
        stage: "readback" as const,
        applied: true,
        transaction,
        pending: readBack.pending,
      };
    }
    const expectedSummary = summarizeModel(transaction.model);
    this.verifyReadBack(expectedSummary, readBack.snapshot);
    return {
      status: "completed" as const,
      stage: "update_definition" as const,
      applied: true,
      transaction,
      definitionHash: readBack.snapshot.definitionHash,
      summary: readBack.snapshot.summary,
    };
  }

  public async deleteSemanticModel(input: DeleteSemanticModelInput) {
    const parsed = parseInput(deleteInputSchema, input, "delete_semantic_model");
    if (parsed.semanticModelId !== parsed.confirmSemanticModelId) {
      throw new DomainError(
        "DELETE_ID_CONFIRMATION_MISMATCH",
        "The repeated semantic model ID does not exactly match the deletion target.",
      );
    }
    const item = await this.fabric.getSemanticModel(parsed.workspaceId, parsed.semanticModelId);
    if (item.displayName !== parsed.confirmDisplayName) {
      throw new DomainError(
        "DELETE_CONFIRMATION_MISMATCH",
        "The confirmation display name does not exactly match the current semantic model name.",
      );
    }
    if (!parsed.apply) {
      return {
        status: "preview" as const,
        stage: "permanent_delete" as const,
        applied: false,
        item,
        hardDelete: true as const,
        irreversible: true as const,
      };
    }
    await this.fabric.permanentlyDeleteSemanticModel(parsed.workspaceId, parsed.semanticModelId);
    return {
      status: "completed" as const,
      stage: "permanent_delete" as const,
      applied: true,
      item,
      hardDelete: true as const,
      irreversible: true as const,
    };
  }

  public async bindSemanticModelConnection(input: BindSemanticModelConnectionInput) {
    const parsed = parseInput(bindInputSchema, input, "bind_semantic_model_connection");
    const snapshotResult = await this.getSnapshot(parsed.workspaceId, parsed.semanticModelId);
    if (snapshotResult.status === "pending") {
      return { ...snapshotResult, applied: false };
    }
    const source = snapshotResult.snapshot.model.dataSources.find((candidate) =>
      sameName(candidate.name, parsed.sourceName),
    );
    if (!source) {
      throw new DomainError(
        "DATA_SOURCE_NOT_FOUND",
        `Data source '${parsed.sourceName}' does not exist in the semantic model.`,
      );
    }
    const expectedDetails = sourceConnectionDetails(source);
    const connection = await this.fabric.getConnection(parsed.connectionId);
    if (!sameConnectionDetails(expectedDetails, connection.connectionDetails)) {
      throw new DomainError(
        "CONNECTION_REFERENCE_MISMATCH",
        `Connection '${connection.displayName}' does not match data source '${source.name}'.`,
      );
    }
    if (!parsed.apply) {
      return {
        status: "preview" as const,
        stage: "bind_connection" as const,
        applied: false,
        sourceName: source.name,
        connection: {
          id: connection.id,
          displayName: connection.displayName,
          connectivityType: connection.connectivityType,
          connectionDetails: connection.connectionDetails,
        },
      };
    }
    await this.fabric.bindSemanticModelConnection(parsed.workspaceId, parsed.semanticModelId, {
      connectionBinding: {
        id: connection.id,
        connectivityType: connection.connectivityType,
        connectionDetails: connection.connectionDetails,
      },
    });
    return {
      status: "completed" as const,
      stage: "bind_connection" as const,
      applied: true,
      sourceName: source.name,
      connection: {
        id: connection.id,
        displayName: connection.displayName,
        connectivityType: connection.connectivityType,
        connectionDetails: connection.connectionDetails,
      },
    };
  }

  private async resolveCreate(
    operation: FabricOperation<SemanticModel>,
  ): Promise<
    | { readonly status: "completed"; readonly data: SemanticModel }
    | { readonly status: "pending"; readonly pending: PendingOperation }
  > {
    if (operation.kind === "completed") return { status: "completed", data: operation.data };
    const polled = await this.poll(operation);
    if (polled.status === "pending") return polled;
    return {
      status: "completed",
      data: await this.fabric.getOperationResult(operation.operationId, semanticModelSchema),
    };
  }

  private async resolveDefinition(
    operation: FabricOperation<SemanticModelDefinition>,
  ): Promise<
    | { readonly status: "completed"; readonly data: SemanticModelDefinition }
    | { readonly status: "pending"; readonly pending: PendingOperation }
  > {
    if (operation.kind === "completed") return { status: "completed", data: operation.data };
    const polled = await this.poll(operation);
    if (polled.status === "pending") return polled;
    const result = await this.fabric.getOperationResult(
      operation.operationId,
      semanticModelDefinitionResponseSchema,
    );
    return { status: "completed", data: result.definition };
  }

  private async resolveUpdate(operation: FabricOperation<undefined>): Promise<PollResult> {
    return operation.kind === "completed" ? { status: "succeeded" } : await this.poll(operation);
  }

  private async poll(operation: AcceptedOperation): Promise<PollResult> {
    const startedAt = this.now();
    let operationStatus = "Accepted";
    let retryAfterMs = operation.retryAfterMs ?? this.pollIntervalMs;

    while (this.now() - startedAt < this.lroPollBudgetMs) {
      const remaining = this.lroPollBudgetMs - (this.now() - startedAt);
      const delay = Math.min(Math.max(1, retryAfterMs), remaining);
      await this.sleep(delay);
      const state = await this.fabric.getOperationState(operation.operationId);
      operationStatus = state.status;
      const status = state.status.toLocaleLowerCase("en-US");
      if (status === "succeeded") return { status: "succeeded" };
      if (status === "failed" || status === "cancelled" || status === "canceled") {
        throw new DomainError(
          status === "failed" ? "FABRIC_OPERATION_FAILED" : "FABRIC_OPERATION_CANCELLED",
          state.error?.message ?? `Fabric operation ${operation.operationId} ${status}.`,
          state.error?.isRetriable ?? false,
        );
      }
      retryAfterMs = this.pollIntervalMs;
    }
    return {
      status: "pending",
      pending: {
        operationId: operation.operationId,
        operationStatus,
        retryAfterMs,
      },
    };
  }

  private verifyReadBack(expected: ModelSummary, actual: ModelSnapshot): void {
    if (
      expected.definitionHash !== actual.definitionHash ||
      !countsMatch(expected.counts, actual.summary.counts)
    ) {
      throw new DomainError(
        "DEFINITION_READBACK_MISMATCH",
        "Fabric read-back did not match the submitted semantic model definition.",
      );
    }
  }
}

export type { ModelTransactionResult };
