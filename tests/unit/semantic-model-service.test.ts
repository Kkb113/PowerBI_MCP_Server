import type { z } from "zod";
import { describe, expect, it } from "vitest";
import type {
  BindConnectionRequest,
  CreateSemanticModelRequest,
  FabricOperation,
  UpdateSemanticModelRequest,
} from "../../src/clients/fabric-client.js";
import type { ApiResponse } from "../../src/clients/http-client.js";
import type {
  Connection,
  OperationState,
  SemanticModel,
  SemanticModelDefinition,
  Workspace,
} from "../../src/clients/schemas.js";
import { buildTmslDefinition, hashModelSpec } from "../../src/model/index.js";
import {
  SemanticModelService,
  summarizeModel,
  type SemanticModelFabricClient,
} from "../../src/services/index.js";
import { loadModelFixture } from "../helpers/model.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPERATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const response = (): ApiResponse<undefined> => ({
  status: 200,
  data: undefined,
  requestId: undefined,
  operationId: undefined,
  location: undefined,
  retryAfterMs: undefined,
});

class FakeFabricClient implements SemanticModelFabricClient {
  public item: SemanticModel = {
    id: MODEL_ID,
    displayName: "Sales",
    description: "Initial",
    type: "SemanticModel",
    workspaceId: WORKSPACE_ID,
  };
  public definition: SemanticModelDefinition = buildTmslDefinition(loadModelFixture());
  public connection: Connection = {
    id: CONNECTION_ID,
    displayName: "Warehouse SQL",
    connectivityType: "ShareableCloud",
    connectionDetails: {
      type: "SQL",
      path: "example.datawarehouse.fabric.microsoft.com;SalesWarehouse",
    },
  };
  public createOperation: FabricOperation<SemanticModel> | undefined;
  public updateOperation: FabricOperation<undefined> = {
    kind: "completed",
    data: undefined,
    requestId: undefined,
  };
  public definitionOperations: FabricOperation<SemanticModelDefinition>[] = [];
  public operationStates: OperationState[] = [];
  public operationResult: unknown;
  public preserveDefinitionOnUpdate = false;
  public createCalls = 0;
  public updatePropertyCalls = 0;
  public updateDefinitionCalls = 0;
  public deleteCalls = 0;
  public bindCalls = 0;
  public stateCalls = 0;
  public lastBinding: BindConnectionRequest | undefined;

  public listWorkspaces(): Promise<readonly Workspace[]> {
    return Promise.resolve([
      { id: WORKSPACE_ID, displayName: "Development", type: "Workspace" },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        displayName: "Secondary",
        type: "Workspace",
      },
    ]);
  }

  public listSemanticModels(): Promise<readonly SemanticModel[]> {
    return Promise.resolve([
      this.item,
      { ...this.item, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", displayName: "Finance" },
    ]);
  }

  public getSemanticModel(): Promise<SemanticModel> {
    return Promise.resolve(this.item);
  }

  public getConnection(): Promise<Connection> {
    return Promise.resolve(this.connection);
  }

  public createSemanticModel(
    workspaceId: string,
    request: CreateSemanticModelRequest,
  ): Promise<FabricOperation<SemanticModel>> {
    this.createCalls += 1;
    this.definition = request.definition;
    this.item = {
      id: MODEL_ID,
      displayName: request.displayName,
      ...(request.description === undefined ? {} : { description: request.description }),
      type: "SemanticModel",
      workspaceId,
    };
    return Promise.resolve(
      this.createOperation ?? { kind: "completed", data: this.item, requestId: undefined },
    );
  }

  public updateSemanticModel(
    _workspaceId: string,
    _semanticModelId: string,
    request: UpdateSemanticModelRequest,
  ): Promise<ApiResponse<undefined>> {
    this.updatePropertyCalls += 1;
    this.item = {
      ...this.item,
      ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
      ...(request.description === undefined ? {} : { description: request.description }),
    };
    return Promise.resolve(response());
  }

  public permanentlyDeleteSemanticModel(): Promise<ApiResponse<undefined>> {
    this.deleteCalls += 1;
    return Promise.resolve(response());
  }

  public getSemanticModelDefinition(): Promise<FabricOperation<SemanticModelDefinition>> {
    return Promise.resolve(
      this.definitionOperations.shift() ?? {
        kind: "completed",
        data: this.definition,
        requestId: undefined,
      },
    );
  }

  public updateSemanticModelDefinition(
    _workspaceId: string,
    _semanticModelId: string,
    definition: SemanticModelDefinition,
  ): Promise<FabricOperation<undefined>> {
    this.updateDefinitionCalls += 1;
    if (!this.preserveDefinitionOnUpdate) this.definition = definition;
    return Promise.resolve(this.updateOperation);
  }

  public bindSemanticModelConnection(
    _workspaceId: string,
    _semanticModelId: string,
    request: BindConnectionRequest,
  ): Promise<ApiResponse<undefined>> {
    this.bindCalls += 1;
    this.lastBinding = request;
    return Promise.resolve(response());
  }

  public getOperationState(): Promise<OperationState> {
    this.stateCalls += 1;
    const state = this.operationStates.shift();
    if (!state) throw new Error("No operation state configured");
    return Promise.resolve(state);
  }

  public getOperationResult<T>(_operationId: string, schema: z.ZodType<T>): Promise<T> {
    return Promise.resolve(schema.parse(this.operationResult));
  }
}

const createService = (
  fabric: FakeFabricClient,
  options: { readonly budget?: number; readonly statesAdvanceTime?: boolean } = {},
): SemanticModelService => {
  let now = 0;
  return new SemanticModelService(fabric, {
    lroPollBudgetMs: options.budget ?? 5_000,
    pollIntervalMs: 100,
    now: () => now,
    sleep: (milliseconds) => {
      if (options.statesAdvanceTime ?? true) now += milliseconds;
      return Promise.resolve();
    },
  });
};

const accepted = <T>(): FabricOperation<T> => ({
  kind: "accepted",
  operationId: OPERATION_ID,
  location: `https://fabric.test/v1/operations/${OPERATION_ID}`,
  requestId: undefined,
  retryAfterMs: 100,
});

const addMeasure = {
  action: "create",
  target: { objectType: "measure", parentName: "Sales Data", name: "Lifecycle Orders" },
  value: {
    name: "Lifecycle Orders",
    expression: "DISTINCTCOUNT('Sales Data'[Order ID])",
    description: "Lifecycle test measure.",
    formatString: "#,0",
  },
};

describe("SemanticModelService reads", () => {
  it("bounds list output with scoped continuation tokens", async () => {
    const service = createService(new FakeFabricClient());
    const first = await service.listWorkspaces({ limit: 1 });
    expect(first.value).toHaveLength(1);
    expect(first.continuationToken).toBeTypeOf("string");
    const second = await service.listWorkspaces({
      limit: 1,
      continuationToken: first.continuationToken,
    });
    expect(second.value[0]?.displayName).toBe("Secondary");
    await expect(
      service.listSemanticModels(WORKSPACE_ID, {
        continuationToken: first.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTINUATION_TOKEN" });
  });

  it("returns bounded metadata without measure expressions", async () => {
    const service = createService(new FakeFabricClient());
    const result = await service.getModelInfo(WORKSPACE_ID, MODEL_ID, {
      sections: ["measures", "tables"],
      limitPerSection: 1,
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed" || !("summary" in result)) return;
    expect(result.summary.measures).toMatchObject({ total: 2, truncated: true });
    expect(JSON.stringify(result)).not.toContain("SUM(");
    expect(result.summary.relationships).toBeUndefined();
  });

  it("summarizes every supported object family with a stable hash", () => {
    const model = loadModelFixture();
    const summary = summarizeModel(model);
    expect(summary.definitionHash).toBe(hashModelSpec(model));
    expect(summary.counts).toMatchObject({
      tables: 4,
      relationships: 3,
      calculationGroups: 1,
      roles: 1,
      dataSources: 1,
    });
  });
});

describe("SemanticModelService safe mutations", () => {
  it("previews creation without calling Fabric and verifies applied creation", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    const model = loadModelFixture();

    const preview = await service.createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Lifecycle model",
      model,
    });
    expect(preview).toMatchObject({ status: "preview", applied: false });
    expect(fabric.createCalls).toBe(0);

    const applied = await service.createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Lifecycle model",
      description: "Disposable",
      model,
      apply: true,
    });
    expect(applied).toMatchObject({ status: "completed", applied: true });
    expect(fabric.createCalls).toBe(1);
  });

  it("previews and applies property updates separately from definitions", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    const preview = await service.updateSemanticModelProperties({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      displayName: "Renamed",
    });
    expect(preview).toMatchObject({ status: "preview", hasChanges: true });
    expect(fabric.updatePropertyCalls).toBe(0);

    const result = await service.updateSemanticModelProperties({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      displayName: "Renamed",
      description: null,
      apply: true,
    });
    expect(result).toMatchObject({ status: "completed", applied: true });
    expect(fabric.item).toMatchObject({ displayName: "Renamed", description: "" });
    expect(fabric.updateDefinitionCalls).toBe(0);
  });

  it("requires a fresh hash before mutation and previews by default", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    await expect(
      service.applyModelChanges({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expectedDefinitionHash: "0".repeat(64),
        operations: [addMeasure],
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "STALE_DEFINITION_HASH" });
    expect(fabric.updateDefinitionCalls).toBe(0);

    const preview = await service.applyModelChanges({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      expectedDefinitionHash: hashModelSpec(loadModelFixture()),
      operations: [addMeasure],
    });
    expect(preview).toMatchObject({
      status: "preview",
      applied: false,
      transaction: { diff: { hasChanges: true } },
    });
    expect(fabric.updateDefinitionCalls).toBe(0);
  });

  it("rejects invalid references before update and verifies successful read-back", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    const definitionHash = hashModelSpec(loadModelFixture());
    await expect(
      service.applyModelChanges({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expectedDefinitionHash: definitionHash,
        operations: [
          {
            action: "create",
            target: { objectType: "relationship", name: "Invalid" },
            value: {
              name: "Invalid",
              fromTable: "Missing",
              fromColumn: "ID",
              toTable: "Calendar",
              toColumn: "Date",
              fromCardinality: "many",
              toCardinality: "one",
            },
          },
        ],
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "MODEL_VALIDATION_FAILED" });
    expect(fabric.updateDefinitionCalls).toBe(0);

    const result = await service.applyModelChanges({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      expectedDefinitionHash: definitionHash,
      operations: [addMeasure],
      apply: true,
    });
    expect(result).toMatchObject({ status: "completed", applied: true });
    expect(fabric.updateDefinitionCalls).toBe(1);
    if (!("transaction" in result)) return;
    expect(result.definitionHash).toBe(result.transaction.afterHash);
  });

  it("fails closed when Fabric read-back differs from the submitted model", async () => {
    const fabric = new FakeFabricClient();
    fabric.preserveDefinitionOnUpdate = true;
    const service = createService(fabric);
    await expect(
      service.applyModelChanges({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expectedDefinitionHash: hashModelSpec(loadModelFixture()),
        operations: [addMeasure],
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "DEFINITION_READBACK_MISMATCH" });
  });

  it("requires repeated ID, exact name, and explicit permanent-delete confirmation", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    await expect(
      service.deleteSemanticModel({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        confirmSemanticModelId: MODEL_ID,
        confirmDisplayName: "sales",
        confirmPermanentDelete: true,
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "DELETE_CONFIRMATION_MISMATCH" });
    expect(fabric.deleteCalls).toBe(0);

    const preview = await service.deleteSemanticModel({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      confirmSemanticModelId: MODEL_ID,
      confirmDisplayName: "Sales",
      confirmPermanentDelete: true,
    });
    expect(preview).toMatchObject({
      status: "preview",
      stage: "permanent_delete",
      hardDelete: true,
      irreversible: true,
    });
    const result = await service.deleteSemanticModel({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      confirmSemanticModelId: MODEL_ID,
      confirmDisplayName: "Sales",
      confirmPermanentDelete: true,
      apply: true,
    });
    expect(result).toMatchObject({
      status: "completed",
      applied: true,
      hardDelete: true,
      irreversible: true,
    });
    expect(fabric.deleteCalls).toBe(1);
  });

  it("rejects a mismatched repeated deletion ID before reading Fabric", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    await expect(
      service.deleteSemanticModel({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        confirmSemanticModelId: CONNECTION_ID,
        confirmDisplayName: "Sales",
        confirmPermanentDelete: true,
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "DELETE_ID_CONFIRMATION_MISMATCH" });
    expect(fabric.deleteCalls).toBe(0);
  });

  it("matches one named TDS source to authoritative connection metadata", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    const preview = await service.bindSemanticModelConnection({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      sourceName: "Warehouse Source",
      connectionId: CONNECTION_ID,
    });
    expect(preview).toMatchObject({ status: "preview", sourceName: "Warehouse Source" });
    expect(fabric.bindCalls).toBe(0);

    const result = await service.bindSemanticModelConnection({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      sourceName: "Warehouse Source",
      connectionId: CONNECTION_ID,
      apply: true,
    });
    expect(result).toMatchObject({ status: "completed", applied: true });
    expect(fabric.lastBinding).toEqual({
      connectionBinding: {
        id: CONNECTION_ID,
        connectivityType: "ShareableCloud",
        connectionDetails: fabric.connection.connectionDetails,
      },
    });
  });

  it("rejects missing or mismatched connection references before binding", async () => {
    const fabric = new FakeFabricClient();
    const service = createService(fabric);
    await expect(
      service.bindSemanticModelConnection({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        sourceName: "Missing",
        connectionId: CONNECTION_ID,
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "DATA_SOURCE_NOT_FOUND" });
    fabric.connection = {
      ...fabric.connection,
      connectionDetails: { type: "SQL", path: "different;database" },
    };
    await expect(
      service.bindSemanticModelConnection({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        sourceName: "Warehouse Source",
        connectionId: CONNECTION_ID,
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "CONNECTION_REFERENCE_MISMATCH" });
    expect(fabric.bindCalls).toBe(0);
  });
});

describe("SemanticModelService long-running operations", () => {
  it("polls accepted creation and retrieves its typed result", async () => {
    const fabric = new FakeFabricClient();
    fabric.createOperation = accepted();
    fabric.operationStates = [{ status: "Running" }, { status: "Succeeded" }];
    fabric.operationResult = fabric.item;
    const result = await createService(fabric).createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Async model",
      model: loadModelFixture(),
      apply: true,
    });
    expect(result).toMatchObject({ status: "completed", applied: true });
    expect(fabric.stateCalls).toBe(2);
  });

  it("returns an operation handle when the polling budget expires", async () => {
    const fabric = new FakeFabricClient();
    fabric.createOperation = accepted();
    const result = await createService(fabric, { budget: 0 }).createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Async model",
      model: loadModelFixture(),
      apply: true,
    });
    expect(result).toMatchObject({
      status: "pending",
      stage: "create",
      pending: { operationId: OPERATION_ID, operationStatus: "Accepted" },
    });
    expect(fabric.stateCalls).toBe(0);
  });

  it("surfaces failed operation state without requesting a result", async () => {
    const fabric = new FakeFabricClient();
    fabric.createOperation = accepted();
    fabric.operationStates = [
      {
        status: "Failed",
        error: { errorCode: "Corruptedhayload", message: "Definition was rejected." },
      },
    ];
    await expect(
      createService(fabric).createSemanticModel({
        workspaceId: WORKSPACE_ID,
        displayName: "Async model",
        model: loadModelFixture(),
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "FABRIC_OPERATION_FAILED" });
  });

  it("handles accepted definition reads through the result endpoint", async () => {
    const fabric = new FakeFabricClient();
    fabric.definitionOperations = [accepted()];
    fabric.operationStates = [{ status: "Succeeded" }];
    fabric.operationResult = { definition: fabric.definition };
    const result = await createService(fabric).getSnapshot(WORKSPACE_ID, MODEL_ID);
    expect(result).toMatchObject({ status: "completed" });
  });
});
