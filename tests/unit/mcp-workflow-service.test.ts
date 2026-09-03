import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/clients/errors.js";
import type { FabricClient } from "../../src/clients/fabric-client.js";
import type { PowerBiClient } from "../../src/clients/powerbi-client.js";
import { DomainError } from "../../src/errors.js";
import { hashModelSpec } from "../../src/model/index.js";
import {
  buildDaxValidationProbe,
  McpWorkflowService,
} from "../../src/services/mcp-workflow-service.js";
import {
  summarizeModel,
  type ModelSnapshot,
  type SemanticModelService,
} from "../../src/services/semantic-model-service.js";
import { loadModelFixture } from "../helpers/model.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REFRESH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const model = loadModelFixture();
const snapshot: ModelSnapshot = {
  item: {
    id: MODEL_ID,
    displayName: "Phase 5 Model",
    type: "SemanticModel",
    workspaceId: WORKSPACE_ID,
  },
  definition: {
    format: "TMSL",
    parts: [{ path: "model.bim", payload: "e30=", payloadType: "InlineBase64" }],
  },
  model,
  definitionProperties: {
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json",
    version: "4.0",
    settings: { qnaEnabled: false },
  },
  additionalParts: [],
  definitionHash: hashModelSpec(model),
  summary: summarizeModel(model),
};

const createHarness = (
  options: {
    readonly maxRows?: number;
    readonly maxBytes?: number;
    readonly readOnly?: boolean;
  } = {},
) => {
  const listWorkspaces = vi.fn().mockResolvedValue({ value: [] });
  const createSemanticModel = vi.fn().mockResolvedValue({ status: "preview", applied: false });
  const listSemanticModels = vi.fn().mockResolvedValue({ value: [] });
  const getSnapshot = vi.fn().mockResolvedValue({ status: "completed", snapshot });
  const semanticModels = {
    listWorkspaces,
    listSemanticModels,
    getSemanticModel: vi.fn().mockResolvedValue(snapshot.item),
    getSnapshot,
    getModelInfo: vi.fn().mockResolvedValue({ status: "completed", summary: snapshot.summary }),
    createSemanticModel,
    updateSemanticModelProperties: vi.fn().mockResolvedValue({ status: "preview", applied: false }),
    applyModelChanges: vi.fn().mockResolvedValue({
      status: "preview",
      applied: false,
      transaction: {
        model,
        beforeHash: snapshot.definitionHash,
        afterHash: snapshot.definitionHash,
        diff: { hasChanges: false, changes: [] },
        operations: [],
      },
    }),
    deleteSemanticModel: vi.fn().mockResolvedValue({ status: "preview", applied: false }),
    bindSemanticModelConnection: vi.fn().mockResolvedValue({ status: "preview", applied: false }),
  } as unknown as SemanticModelService;
  const executeDax = vi.fn().mockResolvedValue({ results: [{ tables: [{ rows: [] }] }] });
  const startRefresh = vi.fn().mockResolvedValue({
    requestId: REFRESH_ID,
    location: `https://powerbi.test/refreshes/${REFRESH_ID}`,
    retryAfterMs: 2_000,
  });
  const getRefreshExecutionDetails = vi.fn().mockResolvedValue({
    status: 202,
    data: { requestId: REFRESH_ID, status: "Unknown", extendedStatus: "InProgress" },
  });
  const fabric = {
    getOperationState: vi.fn().mockResolvedValue({ status: "Running", percentComplete: 40 }),
  } as unknown as Pick<FabricClient, "getOperationState">;
  const powerBi = {
    executeDax,
    startRefresh,
    getRefreshExecutionDetails,
  } as unknown as Pick<PowerBiClient, "executeDax" | "startRefresh" | "getRefreshExecutionDetails">;
  return {
    semanticModels,
    semanticModelMocks: { listWorkspaces, listSemanticModels, createSemanticModel, getSnapshot },
    fabric,
    powerBi,
    powerBiMocks: { executeDax, startRefresh, getRefreshExecutionDetails },
    service: new McpWorkflowService(semanticModels, fabric, powerBi, {
      maxDaxRows: options.maxRows ?? 2,
      maxResponseBytes: options.maxBytes ?? 8_192,
      readOnly: options.readOnly ?? false,
    }),
  };
};

describe("buildDaxValidationProbe", () => {
  it("wraps scalar expressions and preserves complete DAX queries", () => {
    expect(buildDaxValidationProbe("[Total Sales]")).toBe(
      'EVALUATE ROW("validation", [Total Sales])',
    );
    expect(buildDaxValidationProbe(' EVALUATE ROW("x", 1) ')).toBe('EVALUATE ROW("x", 1)');
    expect(buildDaxValidationProbe("DEFINE MEASURE 'T'[M] = 1\nEVALUATE ROW(\"x\", [M])")).toMatch(
      /^DEFINE/u,
    );
  });
});

describe("McpWorkflowService", () => {
  it("routes lifecycle reads and previews through the semantic model service", async () => {
    const { service, semanticModelMocks } = createHarness();

    await expect(service.execute("list_workspaces", {})).resolves.toMatchObject({
      status: "success",
      data: { value: [] },
    });
    await expect(
      service.execute("list_semantic_models", {
        workspaceId: WORKSPACE_ID,
        limit: 25,
        continuationToken: "next-page",
      }),
    ).resolves.toMatchObject({ status: "success", data: { value: [] } });
    expect(semanticModelMocks.listSemanticModels).toHaveBeenCalledWith(WORKSPACE_ID, {
      limit: 25,
      continuationToken: "next-page",
    });
    await expect(
      service.execute("get_semantic_model", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
      }),
    ).resolves.toMatchObject({ data: { id: MODEL_ID } });
    await expect(
      service.execute("get_semantic_model_definition", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        includeDefinition: false,
      }),
    ).resolves.toMatchObject({ data: { definitionHash: snapshot.definitionHash } });
    await expect(
      service.execute("apply_model_changes", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expectedDefinitionHash: snapshot.definitionHash,
        operations: [
          {
            action: "delete",
            target: { objectType: "measure", parentName: "Sales", name: "Total Sales" },
          },
        ],
      }),
    ).resolves.not.toHaveProperty("data.transaction.model");
    expect(semanticModelMocks.listWorkspaces).toHaveBeenCalled();
  });

  it("caps JSON DAX rows at the lower server limit and reports Power BI truncation", async () => {
    const { service, powerBiMocks } = createHarness({ maxRows: 2 });
    powerBiMocks.executeDax.mockResolvedValue({
      results: [
        {
          tables: [
            {
              rows: [{ "[n]": 1 }, { "[n]": 2 }, { "[n]": 3 }],
              error: { code: "MoreRows", message: "More than the allowed number of rows." },
            },
          ],
        },
      ],
    });

    const result = await service.execute("execute_dax", {
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      query: 'EVALUATE ROW("n", 1)',
      maxRows: 10,
      includeNulls: true,
    });

    expect(result.data).toMatchObject({
      returnedRows: 2,
      receivedRows: 3,
      effectiveMaxRows: 2,
      truncated: true,
      truncationReasons: ["row_cap", "powerbi_limit"],
    });
    expect(powerBiMocks.executeDax).toHaveBeenCalledWith(WORKSPACE_ID, MODEL_ID, {
      query: 'EVALUATE ROW("n", 1)',
      includeNulls: true,
    });
  });

  it("caps DAX output by serialized byte size", async () => {
    const { service, powerBiMocks } = createHarness({ maxRows: 10, maxBytes: 1_024 });
    powerBiMocks.executeDax.mockResolvedValue({
      results: [{ tables: [{ rows: [{ "[value]": "x".repeat(2_000) }] }] }],
    });

    await expect(
      service.execute("execute_dax", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        query: 'EVALUATE ROW("value", "x")',
      }),
    ).resolves.toMatchObject({
      data: { returnedRows: 0, truncated: true, truncationReasons: ["response_bytes"] },
    });
  });

  it("returns invalid DAX as a validation result and keeps permission failures as tool errors", async () => {
    const { service, powerBiMocks } = createHarness();
    powerBiMocks.executeDax
      .mockRejectedValueOnce(
        new ApiError("API_REQUEST_FAILED", "DAX syntax error near ')'.", {
          service: "powerbi",
          operation: "execute_dax",
          httpStatus: 400,
          serviceCode: "DAXQueryFailure",
        }),
      )
      .mockRejectedValueOnce(
        new ApiError("FORBIDDEN", "Build permission is required.", {
          service: "powerbi",
          operation: "execute_dax",
          httpStatus: 403,
        }),
      );

    await expect(
      service.execute("validate_dax", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expression: "SUM(",
      }),
    ).resolves.toMatchObject({
      status: "success",
      data: { valid: false, validationError: { code: "DAXQueryFailure" } },
    });
    await expect(
      service.execute("validate_dax", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expression: "1",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails explicitly when the JSON endpoint receives a culture override", async () => {
    const { service, powerBiMocks } = createHarness();
    await expect(
      service.execute("execute_dax", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        query: "EVALUATE ROW()",
        culture: "en-US",
      }),
    ).rejects.toMatchObject({ code: "DAX_CULTURE_OVERRIDE_UNSUPPORTED" });
    expect(powerBiMocks.executeDax).not.toHaveBeenCalled();
  });

  it("blocks every applied mutation at the workflow boundary in read-only mode", async () => {
    const { service, semanticModelMocks, powerBiMocks } = createHarness({ readOnly: true });
    const appliedCalls = [
      {
        name: "create_semantic_model" as const,
        input: { workspaceId: WORKSPACE_ID, displayName: "Blocked", model, apply: true },
      },
      {
        name: "update_semantic_model_properties" as const,
        input: {
          workspaceId: WORKSPACE_ID,
          semanticModelId: MODEL_ID,
          displayName: "Blocked",
          apply: true,
        },
      },
      {
        name: "apply_model_changes" as const,
        input: {
          workspaceId: WORKSPACE_ID,
          semanticModelId: MODEL_ID,
          expectedDefinitionHash: snapshot.definitionHash,
          operations: [
            {
              action: "delete",
              target: { objectType: "measure", parentName: "Sales", name: "Total Sales" },
            },
          ],
          apply: true,
        },
      },
      {
        name: "delete_semantic_model" as const,
        input: {
          workspaceId: WORKSPACE_ID,
          semanticModelId: MODEL_ID,
          confirmSemanticModelId: MODEL_ID,
          confirmDisplayName: "Phase 5 Model",
          confirmPermanentDelete: true,
          apply: true,
        },
      },
      {
        name: "bind_semantic_model_connection" as const,
        input: {
          workspaceId: WORKSPACE_ID,
          semanticModelId: MODEL_ID,
          sourceName: "Source",
          connectionId: OPERATION_ID,
          apply: true,
        },
      },
      {
        name: "refresh_semantic_model" as const,
        input: { workspaceId: WORKSPACE_ID, semanticModelId: MODEL_ID, apply: true },
      },
    ];

    for (const call of appliedCalls) {
      await expect(service.execute(call.name, call.input)).rejects.toMatchObject({
        code: "READ_ONLY_VIOLATION",
      });
    }
    expect(semanticModelMocks.createSemanticModel).not.toHaveBeenCalled();
    expect(semanticModelMocks.getSnapshot).not.toHaveBeenCalled();
    expect(powerBiMocks.startRefresh).not.toHaveBeenCalled();
  });

  it("previews and starts transactional refreshes, then reports running and failed status", async () => {
    const { service, powerBiMocks } = createHarness();
    await expect(
      service.execute("refresh_semantic_model", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        refreshType: "automatic",
      }),
    ).resolves.toMatchObject({ status: "success", data: { applied: false } });
    await expect(
      service.execute("refresh_semantic_model", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        refreshType: "full",
        apply: true,
      }),
    ).resolves.toMatchObject({
      status: "pending",
      data: { refreshId: REFRESH_ID, applied: true },
    });
    expect(powerBiMocks.startRefresh).toHaveBeenCalledWith(WORKSPACE_ID, MODEL_ID, {
      type: "full",
      commitMode: "transactional",
    });
    await expect(
      service.execute("get_refresh_status", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        refreshId: REFRESH_ID,
      }),
    ).resolves.toMatchObject({ status: "pending", data: { terminal: false } });

    powerBiMocks.getRefreshExecutionDetails.mockResolvedValue({
      status: 200,
      data: {
        requestId: REFRESH_ID,
        status: "Failed",
        serviceExceptionJson: JSON.stringify({ error: { message: "Source unavailable" } }),
      },
      requestId: undefined,
      operationId: undefined,
      location: undefined,
      retryAfterMs: undefined,
    });
    await expect(
      service.execute("get_refresh_status", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        refreshId: REFRESH_ID,
      }),
    ).resolves.toMatchObject({
      status: "success",
      data: { terminal: true, succeeded: false, diagnostics: ["Source unavailable"] },
    });
  });

  it("returns resumable operation state and normalized snapshot, diff, and gate results", async () => {
    const { service, fabric } = createHarness();
    await expect(
      service.execute("get_operation_status", { operationId: OPERATION_ID }),
    ).resolves.toMatchObject({ status: "pending", data: { percentComplete: 40 } });
    vi.mocked(fabric.getOperationState).mockResolvedValue({
      status: "Succeeded",
      percentComplete: 100,
    });
    await expect(
      service.execute("get_operation_status", { operationId: OPERATION_ID }),
    ).resolves.toMatchObject({
      status: "success",
      data: {
        resultAvailability: "operation_dependent",
        resultPath: `/v1/operations/${OPERATION_ID}/result`,
      },
    });
    await expect(
      service.execute("model_snapshot", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
      }),
    ).resolves.toMatchObject({ data: { definitionHash: snapshot.definitionHash } });
    await expect(
      service.execute("model_diff", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        proposed: { kind: "model_spec", model },
      }),
    ).resolves.toMatchObject({ data: { diff: { hasChanges: false } } });
    await expect(
      service.execute("pre_deploy_gate", { model, checks: ["structure", "dax"] }),
    ).resolves.toMatchObject({ data: { passed: true } });
  });

  it("returns selected semantic invariant failures as pre-deployment gate findings", async () => {
    const { service } = createHarness();
    const duplicateNameModel = {
      ...model,
      tables: [...model.tables, { ...model.tables[0]!, name: model.tables[0]!.name }],
    };

    await expect(
      service.execute("pre_deploy_gate", {
        model: duplicateNameModel,
        checks: ["names"],
      }),
    ).resolves.toMatchObject({
      data: {
        passed: false,
        definitionHash: null,
        findings: [{ code: "DUPLICATE_NAME", severity: "error" }],
      },
    });
  });

  it("rejects malformed tool input and non-truncation query errors", async () => {
    const { service, powerBiMocks } = createHarness();
    await expect(service.execute("list_semantic_models", {})).rejects.toBeInstanceOf(DomainError);
    powerBiMocks.executeDax.mockResolvedValue({
      results: [{ error: { code: "DAX", message: "Unknown measure." } }],
    });
    await expect(
      service.execute("execute_dax", {
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        query: "EVALUATE ROW()",
      }),
    ).rejects.toMatchObject({ code: "DAX_QUERY_FAILED" });
  });
});
