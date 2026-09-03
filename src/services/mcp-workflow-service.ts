import { z } from "zod";
import type { FabricClient } from "../clients/fabric-client.js";
import { ApiError } from "../clients/errors.js";
import type { PowerBiClient } from "../clients/powerbi-client.js";
import type { ExecuteQueriesResponse, RefreshExecutionDetails } from "../clients/schemas.js";
import { DomainError } from "../errors.js";
import {
  applyModelChanges,
  diffModelSpecs,
  lintDax,
  normalizeModelSpec,
  validateModelSpec,
  type DaxFinding,
  type ModelSpec,
} from "../model/index.js";
import { TOOL_REGISTRY, WRITE_TOOL_NAMES } from "../mcp/registry.js";
import { jsonValueSchema, type JsonValue } from "../mcp/schemas.js";
import type { SemanticModelService } from "./semantic-model-service.js";
import { summarizeModel } from "./semantic-model-service.js";

type ToolName = (typeof TOOL_REGISTRY)[number]["name"];
type ToolDefinition<Name extends ToolName> = Extract<
  (typeof TOOL_REGISTRY)[number],
  { readonly name: Name }
>;
type ToolInput<Name extends ToolName> = z.output<ToolDefinition<Name>["inputSchema"]>;

export interface ToolExecution {
  readonly status: "success" | "pending";
  readonly message: string;
  readonly data: Readonly<Record<string, JsonValue>>;
}

export interface McpToolHandler {
  execute(name: ToolName, input: unknown): Promise<ToolExecution>;
}

export interface McpWorkflowOptions {
  readonly maxDaxRows: number;
  readonly maxResponseBytes: number;
  readonly readOnly: boolean;
}

type FabricOperations = Pick<FabricClient, "getOperationState">;
type PowerBiOperations = Pick<
  PowerBiClient,
  "executeDax" | "startRefresh" | "getRefreshExecutionDetails"
>;

const jsonRecordSchema = z.record(z.string(), jsonValueSchema);
const TRUNCATION_PATTERN = /more than|too many|row limit|value limit|size limit|truncat/iu;
const TERMINAL_REFRESH_STATES = new Set([
  "completed",
  "failed",
  "timedout",
  "disabled",
  "cancelled",
  "canceled",
]);

const parseToolInput = <Name extends ToolName>(name: Name, input: unknown): ToolInput<Name> => {
  const definition = TOOL_REGISTRY.find((candidate) => candidate.name === name);
  if (!definition) {
    throw new DomainError("UNKNOWN_TOOL", `The MCP tool '${name}' is not registered.`);
  }
  const parsed = definition.inputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join(".") || "input";
    throw new DomainError(
      "INVALID_REQUEST",
      `${name} input is invalid at '${path}': ${issue?.message ?? "validation failed"}.`,
    );
  }
  return parsed.data as ToolInput<Name>;
};

const toJsonRecord = (value: unknown): Readonly<Record<string, JsonValue>> => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new DomainError("INVALID_TOOL_RESULT", "The tool returned no structured data.");
  }
  const parsed: unknown = JSON.parse(serialized);
  const result = jsonRecordSchema.safeParse(parsed);
  if (!result.success) {
    throw new DomainError("INVALID_TOOL_RESULT", "The tool returned non-JSON structured data.");
  }
  return result.data;
};

const pendingExecution = (message: string, value: unknown): ToolExecution => ({
  status: "pending",
  message,
  data: toJsonRecord(value),
});

const successExecution = (message: string, value: unknown): ToolExecution => ({
  status: "success",
  message,
  data: toJsonRecord(value),
});

const isPending = (value: unknown): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    "status" in value &&
    (value as { readonly status?: unknown }).status === "pending",
  );

const boundedMessage = (value: string | undefined, fallback: string): string =>
  (value?.trim() || fallback).slice(0, 512);

const queryErrors = (response: ExecuteQueriesResponse) => {
  const errors: Array<{ readonly code?: string; readonly message: string }> = [];
  const add = (
    error:
      { readonly code?: string | undefined; readonly message?: string | undefined } | undefined,
  ): void => {
    if (!error) return;
    errors.push({
      ...(error.code === undefined ? {} : { code: error.code }),
      message: boundedMessage(error.message, "Power BI returned a DAX query error."),
    });
  };

  add(response.error);
  for (const result of response.results) {
    add(result.error);
    for (const table of result.tables ?? []) add(table.error);
  }
  return errors;
};

const queryRows = (response: ExecuteQueriesResponse): Readonly<Record<string, JsonValue>>[] =>
  response.results.flatMap((result) => (result.tables ?? []).flatMap((table) => table.rows ?? []));

const capRows = (
  rows: readonly Readonly<Record<string, JsonValue>>[],
  maxRows: number,
  maxBytes: number,
) => {
  const value: Readonly<Record<string, JsonValue>>[] = [];
  let bytes = 256;
  let responseBytesExceeded = false;
  for (const row of rows.slice(0, maxRows)) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + rowBytes > maxBytes) {
      responseBytesExceeded = true;
      break;
    }
    value.push(row);
    bytes += rowBytes;
  }
  return {
    value,
    rowLimitExceeded: rows.length > maxRows,
    responseBytesExceeded,
  };
};

export function buildDaxValidationProbe(expression: string): string {
  const trimmed = expression.trim();
  return /^(?:DEFINE|EVALUATE)\b/iu.test(trimmed)
    ? trimmed
    : `EVALUATE ROW("validation", ${trimmed})`;
}

const stripTransactionModel = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || !("transaction" in value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  const transaction = record["transaction"];
  if (!transaction || typeof transaction !== "object") return value;
  const transactionRecord = transaction as Readonly<Record<string, unknown>>;
  const boundedTransaction = Object.fromEntries(
    Object.entries(transactionRecord).filter(([key]) => key !== "model"),
  );
  return { ...record, transaction: boundedTransaction };
};

const diagnosticMessages = (details: RefreshExecutionDetails): readonly string[] => {
  const messages = (details.messages ?? [])
    .map((entry) => entry.message?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const exceptionSources = [
    details.serviceExceptionJson,
    ...(details.refreshAttempts ?? []).map((attempt) => attempt.serviceExceptionJson),
  ];
  for (const source of exceptionSources) {
    if (!source) continue;
    try {
      const parsed: unknown = JSON.parse(source);
      const pending: unknown[] = [parsed];
      let visited = 0;
      while (pending.length > 0 && messages.length < 10 && visited < 200) {
        const current = pending.shift();
        visited += 1;
        if (!current || typeof current !== "object") continue;
        if (Array.isArray(current)) {
          for (const item of current.slice(0, 20) as unknown[]) pending.push(item);
          continue;
        }
        for (const [key, item] of Object.entries(current).slice(0, 50)) {
          if (/message|description/iu.test(key) && typeof item === "string" && item.trim()) {
            messages.push(item.trim());
          } else if (item && typeof item === "object") {
            pending.push(item);
          }
        }
      }
    } catch {
      messages.push("Power BI returned non-JSON refresh diagnostics.");
    }
  }
  return [...new Set(messages.map((message) => message.slice(0, 2_000)))].slice(0, 10);
};

interface GateFinding {
  readonly severity: "info" | "warning" | "error";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

const daxExpressions = (model: ModelSpec) => {
  const expressions: Array<{ readonly path: string; readonly expression: string }> = [];
  for (const table of model.tables) {
    for (const column of table.columns) {
      if (column.kind === "calculated") {
        expressions.push({
          path: `tables.${table.name}.columns.${column.name}`,
          expression: column.expression,
        });
      }
    }
    for (const partition of table.partitions) {
      if (partition.kind === "calculated") {
        expressions.push({
          path: `tables.${table.name}.partitions.${partition.name}`,
          expression: partition.expression,
        });
      }
    }
    for (const measure of table.measures) {
      expressions.push({
        path: `tables.${table.name}.measures.${measure.name}`,
        expression: measure.expression,
      });
    }
  }
  for (const group of model.calculationGroups) {
    for (const item of group.items) {
      expressions.push({
        path: `calculationGroups.${group.tableName}.items.${item.name}`,
        expression: item.expression,
      });
      if (item.formatStringExpression) {
        expressions.push({
          path: `calculationGroups.${group.tableName}.items.${item.name}.formatStringExpression`,
          expression: item.formatStringExpression,
        });
      }
    }
  }
  for (const role of model.roles) {
    for (const permission of role.tablePermissions) {
      expressions.push({
        path: `roles.${role.name}.tablePermissions.${permission.table}`,
        expression: permission.filterExpression,
      });
    }
  }
  return expressions;
};

const lintFindingToGate = (finding: DaxFinding, path: string): GateFinding => ({
  severity: finding.severity,
  code: finding.ruleId,
  path,
  message: finding.message,
});

export class McpWorkflowService implements McpToolHandler {
  public constructor(
    private readonly semanticModels: SemanticModelService,
    private readonly fabric: FabricOperations,
    private readonly powerBi: PowerBiOperations,
    private readonly options: McpWorkflowOptions,
  ) {
    z.number().int().min(1).max(10_000).parse(options.maxDaxRows);
    z.number().int().min(1_024).max(10_485_760).parse(options.maxResponseBytes);
  }

  public async execute(name: ToolName, rawInput: unknown): Promise<ToolExecution> {
    if (
      this.options.readOnly &&
      WRITE_TOOL_NAMES.includes(name as (typeof WRITE_TOOL_NAMES)[number]) &&
      rawInput !== null &&
      typeof rawInput === "object" &&
      (rawInput as Readonly<Record<string, unknown>>)["apply"] === true
    ) {
      throw new DomainError("READ_ONLY_VIOLATION", "The server is configured in read-only mode.");
    }
    switch (name) {
      case "list_workspaces": {
        const input = parseToolInput(name, rawInput);
        return successExecution(
          "Fabric workspaces listed.",
          await this.semanticModels.listWorkspaces(input),
        );
      }
      case "list_semantic_models": {
        const input = parseToolInput(name, rawInput);
        return successExecution(
          "Semantic models listed.",
          await this.semanticModels.listSemanticModels(input.workspaceId, {
            limit: input.limit,
            ...(input.continuationToken === undefined
              ? {}
              : { continuationToken: input.continuationToken }),
          }),
        );
      }
      case "get_semantic_model": {
        const input = parseToolInput(name, rawInput);
        return successExecution(
          "Semantic model properties retrieved.",
          await this.semanticModels.getSemanticModel(input.workspaceId, input.semanticModelId),
        );
      }
      case "get_semantic_model_definition": {
        const input = parseToolInput(name, rawInput);
        const result = await this.semanticModels.getSnapshot(
          input.workspaceId,
          input.semanticModelId,
        );
        if (result.status === "pending") {
          return pendingExecution("Semantic model definition retrieval is still running.", result);
        }
        return this.boundedSuccess("Semantic model definition retrieved.", {
          item: result.snapshot.item,
          format: "TMSL",
          definitionHash: result.snapshot.definitionHash,
          summary: result.snapshot.summary,
          ...(input.includeDefinition ? { model: result.snapshot.model } : {}),
        });
      }
      case "get_model_info": {
        const input = parseToolInput(name, rawInput);
        const result = await this.semanticModels.getModelInfo(
          input.workspaceId,
          input.semanticModelId,
          {
            sections: input.sections,
            limitPerSection: input.limitPerSection,
          },
        );
        return isPending(result)
          ? pendingExecution("Semantic model metadata retrieval is still running.", result)
          : successExecution("Semantic model metadata retrieved.", result);
      }
      case "create_semantic_model": {
        const input = parseToolInput(name, rawInput);
        const result = await this.semanticModels.createSemanticModel({
          workspaceId: input.workspaceId,
          displayName: input.displayName,
          model: input.model,
          apply: input.apply,
          ...(input.description === undefined ? {} : { description: input.description }),
        });
        return isPending(result)
          ? pendingExecution("Semantic model creation is still running.", result)
          : successExecution(
              input.apply
                ? "Semantic model creation completed."
                : "Semantic model creation previewed.",
              result,
            );
      }
      case "update_semantic_model_properties": {
        const input = parseToolInput(name, rawInput);
        const result = await this.semanticModels.updateSemanticModelProperties({
          workspaceId: input.workspaceId,
          semanticModelId: input.semanticModelId,
          apply: input.apply,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.description === undefined ? {} : { description: input.description }),
        });
        return successExecution(
          input.apply
            ? "Semantic model properties updated."
            : "Semantic model property update previewed.",
          result,
        );
      }
      case "apply_model_changes": {
        const input = parseToolInput(name, rawInput);
        const result = stripTransactionModel(await this.semanticModels.applyModelChanges(input));
        return isPending(result)
          ? pendingExecution("Semantic model definition update is still running.", result)
          : this.boundedSuccess(
              input.apply ? "Semantic model changes applied." : "Semantic model changes previewed.",
              result,
            );
      }
      case "delete_semantic_model": {
        const input = parseToolInput(name, rawInput);
        return successExecution(
          input.apply
            ? "Semantic model permanently deleted."
            : "Permanent semantic model deletion previewed.",
          await this.semanticModels.deleteSemanticModel(input),
        );
      }
      case "bind_semantic_model_connection": {
        const input = parseToolInput(name, rawInput);
        const result = await this.semanticModels.bindSemanticModelConnection(input);
        return isPending(result)
          ? pendingExecution("Connection binding preparation is still running.", result)
          : successExecution(
              input.apply
                ? "Semantic model connection bound."
                : "Semantic model connection binding previewed.",
              result,
            );
      }
      case "validate_dax":
        return await this.validateDax(parseToolInput(name, rawInput));
      case "execute_dax":
        return await this.executeDax(parseToolInput(name, rawInput));
      case "refresh_semantic_model":
        return await this.refreshSemanticModel(parseToolInput(name, rawInput));
      case "get_refresh_status":
        return await this.getRefreshStatus(parseToolInput(name, rawInput));
      case "get_operation_status": {
        const input = parseToolInput(name, rawInput);
        const state = await this.fabric.getOperationState(input.operationId);
        const normalized = state.status.toLocaleLowerCase("en-US");
        const pending = !["succeeded", "failed", "cancelled", "canceled"].includes(normalized);
        const data = {
          operationId: input.operationId,
          ...state,
          resultAvailability: normalized === "succeeded" ? "operation_dependent" : "not_ready",
          resultPath:
            normalized === "succeeded" ? `/v1/operations/${input.operationId}/result` : null,
        };
        return pending
          ? pendingExecution("Fabric operation is still running.", data)
          : successExecution("Fabric operation reached a terminal state.", data);
      }
      case "model_snapshot":
        return await this.modelSnapshot(parseToolInput(name, rawInput));
      case "model_diff":
        return await this.modelDiff(parseToolInput(name, rawInput));
      case "pre_deploy_gate":
        return await this.preDeployGate(parseToolInput(name, rawInput));
    }
  }

  private async validateDax(input: ToolInput<"validate_dax">): Promise<ToolExecution> {
    this.assertJsonEndpointCulture(input.culture);
    const lint = lintDax(input.expression);
    const probe = buildDaxValidationProbe(input.expression);
    try {
      await this.runDax(input.workspaceId, input.semanticModelId, probe, 1, true);
      return successExecution("DAX validation completed.", {
        valid: true,
        authoritative: "powerbi_executeQueries",
        probeKind: probe === input.expression.trim() ? "query" : "scalar_wrapper",
        lint,
      });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.service === "powerbi" && error.httpStatus === 400) {
        return successExecution("DAX validation completed with an invalid expression.", {
          valid: false,
          authoritative: "powerbi_executeQueries",
          lint,
          validationError: { code: error.serviceCode ?? error.code, message: error.message },
        });
      }
      if (error instanceof DomainError && error.code === "DAX_QUERY_FAILED") {
        return successExecution("DAX validation completed with an invalid expression.", {
          valid: false,
          authoritative: "powerbi_executeQueries",
          lint,
          validationError: { code: error.code, message: error.message },
        });
      }
      throw error;
    }
  }

  private async executeDax(input: ToolInput<"execute_dax">): Promise<ToolExecution> {
    this.assertJsonEndpointCulture(input.culture);
    const result = await this.runDax(
      input.workspaceId,
      input.semanticModelId,
      input.query,
      input.maxRows,
      input.includeNulls,
    );
    return this.boundedSuccess("DAX query completed.", result);
  }

  private async runDax(
    workspaceId: string,
    semanticModelId: string,
    query: string,
    requestedMaxRows: number,
    includeNulls: boolean,
  ) {
    const maxRows = Math.min(requestedMaxRows, this.options.maxDaxRows);
    const response = await this.powerBi.executeDax(workspaceId, semanticModelId, {
      query,
      includeNulls,
    });
    const errors = queryErrors(response);
    const truncationErrors = errors.filter((error) => TRUNCATION_PATTERN.test(error.message));
    const fatalError = errors.find((error) => !TRUNCATION_PATTERN.test(error.message));
    if (fatalError) {
      throw new DomainError("DAX_QUERY_FAILED", fatalError.message);
    }
    const received = queryRows(response);
    const capped = capRows(received, maxRows, this.options.maxResponseBytes);
    const rows = [...capped.value];
    let responseBytesExceeded = capped.responseBytesExceeded;
    const buildResult = () => {
      const truncationReasons = [
        ...(capped.rowLimitExceeded ? ["row_cap"] : []),
        ...(responseBytesExceeded ? ["response_bytes"] : []),
        ...(truncationErrors.length > 0 ? ["powerbi_limit"] : []),
      ];
      return {
        rows,
        columns: [...new Set(rows.flatMap((row) => Object.keys(row)))],
        returnedRows: rows.length,
        receivedRows: received.length,
        requestedMaxRows,
        effectiveMaxRows: maxRows,
        truncated: truncationReasons.length > 0,
        truncationReasons,
        warnings: truncationErrors.slice(0, 3),
      };
    };
    let result = buildResult();
    while (
      rows.length > 0 &&
      Buffer.byteLength(JSON.stringify(result), "utf8") > this.options.maxResponseBytes
    ) {
      rows.pop();
      responseBytesExceeded = true;
      result = buildResult();
    }
    const responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    return { ...result, responseBytes };
  }

  private async refreshSemanticModel(
    input: ToolInput<"refresh_semantic_model">,
  ): Promise<ToolExecution> {
    const request = { type: input.refreshType, commitMode: "transactional" as const };
    if (!input.apply) {
      return successExecution("Semantic model refresh previewed.", {
        status: "preview",
        applied: false,
        request,
      });
    }
    const started = await this.powerBi.startRefresh(
      input.workspaceId,
      input.semanticModelId,
      request,
    );
    return pendingExecution("Semantic model refresh accepted by Power BI.", {
      status: "pending",
      applied: true,
      refreshId: started.requestId,
      location: started.location,
      retryAfterMs: started.retryAfterMs ?? 1_000,
    });
  }

  private async getRefreshStatus(input: ToolInput<"get_refresh_status">): Promise<ToolExecution> {
    const response = await this.powerBi.getRefreshExecutionDetails(
      input.workspaceId,
      input.semanticModelId,
      input.refreshId,
    );
    if (!response.data) {
      throw new DomainError("INVALID_API_RESPONSE", "Power BI returned no refresh status data.");
    }
    const details = response.data;
    const state = (details.extendedStatus ?? details.status ?? "Unknown").toLocaleLowerCase(
      "en-US",
    );
    const terminal = TERMINAL_REFRESH_STATES.has(state);
    const data = {
      refreshId: input.refreshId,
      status: details.status ?? "Unknown",
      extendedStatus: details.extendedStatus ?? null,
      refreshType: details.currentRefreshType ?? details.type ?? details.refreshType ?? null,
      commitMode: details.commitMode ?? null,
      startTime: details.startTime ?? null,
      endTime: details.endTime ?? null,
      numberOfAttempts: details.numberOfAttempts ?? details.refreshAttempts?.length ?? 0,
      terminal,
      succeeded: state === "completed",
      diagnostics: diagnosticMessages(details),
    };
    return terminal && response.status === 200
      ? successExecution("Semantic model refresh reached a terminal state.", data)
      : pendingExecution("Semantic model refresh is still running.", data);
  }

  private async modelSnapshot(input: ToolInput<"model_snapshot">): Promise<ToolExecution> {
    const result = await this.semanticModels.getSnapshot(input.workspaceId, input.semanticModelId);
    if (result.status === "pending") {
      return pendingExecution("Semantic model snapshot is still being retrieved.", result);
    }
    return this.boundedSuccess("Semantic model snapshot created.", {
      item: result.snapshot.item,
      definitionHash: result.snapshot.definitionHash,
      summary: result.snapshot.summary,
      ...(input.includeDefinition ? { model: result.snapshot.model } : {}),
    });
  }

  private async modelDiff(input: ToolInput<"model_diff">): Promise<ToolExecution> {
    const current = await this.semanticModels.getSnapshot(input.workspaceId, input.semanticModelId);
    if (current.status === "pending") {
      return pendingExecution("Live semantic model definition is still being retrieved.", current);
    }
    let proposed: ModelSpec;
    let operations: unknown = null;
    if (input.proposed.kind === "model_spec") {
      proposed = normalizeModelSpec(input.proposed.model);
    } else {
      if (input.proposed.expectedDefinitionHash !== current.snapshot.definitionHash) {
        throw new DomainError(
          "STALE_DEFINITION_HASH",
          "The semantic model definition changed after the proposed operations were prepared.",
        );
      }
      const transaction = applyModelChanges(current.snapshot.model, input.proposed.operations);
      proposed = transaction.model;
      operations = transaction.operations;
    }
    const diff = diffModelSpecs(current.snapshot.model, proposed);
    return this.boundedSuccess("Semantic model diff created.", {
      currentDefinitionHash: current.snapshot.definitionHash,
      proposedDefinitionHash: summarizeModel(proposed).definitionHash,
      diff,
      operations,
    });
  }

  private async preDeployGate(input: ToolInput<"pre_deploy_gate">): Promise<ToolExecution> {
    let model: ModelSpec;
    if (input.model) {
      model = input.model;
    } else {
      const current = await this.semanticModels.getSnapshot(
        input.workspaceId!,
        input.semanticModelId!,
      );
      if (current.status === "pending") {
        return pendingExecution(
          "Live semantic model definition is still being retrieved.",
          current,
        );
      }
      model = current.snapshot.model;
    }

    const structuralIssues = validateModelSpec(model);
    if (structuralIssues.length === 0) model = normalizeModelSpec(model);
    const findings: GateFinding[] = [];
    const checkResults: Array<Readonly<Record<string, JsonValue>>> = [];
    const structureSelected = input.checks.includes("structure");
    const addStructuralIssues = (predicate: (code: string, path: string) => boolean): void => {
      if (structureSelected) return;
      for (const issue of structuralIssues) {
        if (predicate(issue.code, issue.path)) {
          findings.push({
            severity: "error",
            code: issue.code,
            path: issue.path,
            message: issue.message,
          });
        }
      }
    };
    for (const check of input.checks) {
      const before = findings.length;
      if (check === "structure") {
        for (const issue of structuralIssues) {
          findings.push({
            severity: "error",
            code: issue.code,
            path: issue.path,
            message: issue.message,
          });
        }
      } else if (check === "names") {
        addStructuralIssues((code) => code === "DUPLICATE_NAME");
      } else if (check === "dax") {
        addStructuralIssues((code) =>
          ["MISSING_DAX_REFERENCE", "CIRCULAR_MEASURE_DEPENDENCY"].includes(code),
        );
        for (const candidate of daxExpressions(model)) {
          findings.push(
            ...lintDax(candidate.expression, candidate.path).map((item) =>
              lintFindingToGate(item, candidate.path),
            ),
          );
        }
      } else if (check === "relationships") {
        addStructuralIssues((_code, path) => path.startsWith("relationships"));
        for (const relationship of model.relationships) {
          if (relationship.fromCardinality === "many" && relationship.toCardinality === "many") {
            findings.push({
              severity: "warning",
              code: "MANY_TO_MANY_RELATIONSHIP",
              path: `relationships.${relationship.name}`,
              message:
                "Many-to-many relationships should be reviewed for ambiguous filter behavior.",
            });
          }
          if (relationship.crossFilteringBehavior === "bothDirections") {
            findings.push({
              severity: "warning",
              code: "BIDIRECTIONAL_FILTER",
              path: `relationships.${relationship.name}`,
              message:
                "Bidirectional filtering should be justified to avoid ambiguous filter paths.",
            });
          }
        }
      } else if (check === "connections") {
        addStructuralIssues((code) => code === "MISSING_DATA_SOURCE");
        for (const source of model.dataSources) {
          if (Object.keys(source.connectionDetails.address).length === 0) {
            findings.push({
              severity: "error",
              code: "EMPTY_CONNECTION_ADDRESS",
              path: `dataSources.${source.name}.connectionDetails.address`,
              message: "The structured data source address must not be empty.",
            });
          }
        }
      }
      const added = findings.slice(before);
      checkResults.push({
        check,
        passed: !added.some((finding) => finding.severity === "error"),
        findingCount: added.length,
      });
    }
    const blockOnWarnings = input.options["blockOnWarnings"] === true;
    const passed = !findings.some(
      (finding) =>
        finding.severity === "error" || (blockOnWarnings && finding.severity === "warning"),
    );
    return this.boundedSuccess("Pre-deployment checks completed.", {
      passed,
      definitionHash: structuralIssues.length === 0 ? summarizeModel(model).definitionHash : null,
      blockOnWarnings,
      checks: checkResults,
      findings,
    });
  }

  private assertJsonEndpointCulture(culture: string | undefined): void {
    if (culture === undefined) return;
    try {
      Intl.getCanonicalLocales(culture);
    } catch {
      throw new DomainError("INVALID_DAX_CULTURE", `Culture '${culture}' is not a valid locale.`);
    }
    throw new DomainError(
      "DAX_CULTURE_OVERRIDE_UNSUPPORTED",
      "The JSON executeQueries endpoint does not support a per-request culture override. Omit culture to use the semantic model culture.",
    );
  }

  private boundedSuccess(message: string, value: unknown): ToolExecution {
    const data = toJsonRecord(value);
    const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
    if (bytes > this.options.maxResponseBytes) {
      throw new DomainError(
        "TOOL_OUTPUT_TOO_LARGE",
        "The requested output exceeds the configured response limit. Request a bounded summary or fewer objects.",
      );
    }
    return { status: "success", message, data };
  }
}
