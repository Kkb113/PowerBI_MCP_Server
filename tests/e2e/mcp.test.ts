import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FabricClient } from "../../src/clients/fabric-client.js";
import type { PowerBiClient } from "../../src/clients/powerbi-client.js";
import type { FabricDataService } from "../../src/services/fabric-data-service.js";
import { DomainError } from "../../src/errors.js";
import { hashModelSpec } from "../../src/model/index.js";
import { RESOURCE_REGISTRY, TOOL_NAMES } from "../../src/mcp/registry.js";
import { McpWorkflowService } from "../../src/services/mcp-workflow-service.js";
import {
  summarizeModel,
  type ModelSnapshot,
  type SemanticModelService,
} from "../../src/services/semantic-model-service.js";
import { TEST_API_KEY, startTestHttpServer, type TestHttpServer } from "../helpers/http-server.js";
import { loadModelFixture } from "../helpers/model.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TRACKING_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("remote MCP end to end", () => {
  let testServer: TestHttpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await testServer?.close();
    client = undefined;
    testServer = undefined;
  });

  it("initializes, discovers the published contract, reads resources, and invokes a real handler", async () => {
    testServer = await startTestHttpServer();
    const transport = new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
      authProvider: { token: () => Promise.resolve(TEST_API_KEY) },
    });
    client = new Client({ name: "protocol-e2e", version: "1.0.0" });

    await client.connect(transport);

    const listedTools = await client.listTools();
    expect(listedTools.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(listedTools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

    const listedResources = await client.listResources();
    expect(listedResources.resources.map((resource) => resource.uri)).toEqual(
      RESOURCE_REGISTRY.map((resource) => resource.uri),
    );

    const resource = await client.readResource({ uri: "fabric://reference/capabilities" });
    expect(resource.contents[0]).toMatchObject({
      uri: "fabric://reference/capabilities",
      mimeType: "application/json",
    });
    const content = resource.contents[0];
    expect(content && "text" in content ? JSON.parse(content.text) : undefined).toMatchObject({
      implementationStatus: "production",
      fabricMutationEnabled: false,
      dataInspectionEnabled: true,
    });

    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      status: "success",
      data: { tool: "list_workspaces" },
      error: null,
    });
  });

  it("executes every published tool through the MCP transport and workflow router", async () => {
    const model = loadModelFixture();
    const item = {
      id: MODEL_ID,
      displayName: "Workflow E2E",
      type: "SemanticModel" as const,
      workspaceId: WORKSPACE_ID,
    };
    const snapshot: ModelSnapshot = {
      item,
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
    const semanticModels = {
      listWorkspaces: vi.fn().mockResolvedValue({ value: [] }),
      listSemanticModels: vi.fn().mockResolvedValue({ value: [item] }),
      getSemanticModel: vi.fn().mockResolvedValue(item),
      getSnapshot: vi.fn().mockResolvedValue({ status: "completed", snapshot }),
      getModelInfo: vi.fn().mockResolvedValue({ status: "completed", summary: snapshot.summary }),
      createSemanticModel: vi.fn().mockResolvedValue({ status: "preview", applied: false }),
      updateSemanticModelProperties: vi
        .fn()
        .mockResolvedValue({ status: "preview", applied: false }),
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
    const fabric = {
      getOperationState: vi.fn().mockResolvedValue({ status: "Succeeded", percentComplete: 100 }),
    } as unknown as Pick<FabricClient, "getOperationState">;
    const powerBi = {
      executeDax: vi.fn().mockResolvedValue({
        results: [{ tables: [{ rows: [{ "[Smoke]": 1 }] }] }],
      }),
      startRefresh: vi.fn().mockResolvedValue({
        requestId: TRACKING_ID,
        location: `https://powerbi.test/refreshes/${TRACKING_ID}`,
        retryAfterMs: 1_000,
      }),
      getRefreshExecutionDetails: vi.fn().mockResolvedValue({
        status: 200,
        data: { requestId: TRACKING_ID, status: "Completed" },
      }),
    } as unknown as Pick<
      PowerBiClient,
      "executeDax" | "startRefresh" | "getRefreshExecutionDetails"
    >;
    const fabricData = {
      listLakehouses: vi.fn().mockResolvedValue({ value: [] }),
      getLakehouse: vi.fn().mockResolvedValue({}),
      listLakehouseTables: vi.fn().mockResolvedValue({ value: [] }),
      listWarehouses: vi.fn().mockResolvedValue({ value: [] }),
      getWarehouse: vi.fn().mockResolvedValue({}),
      inspectSchema: vi.fn().mockResolvedValue({ columns: [], truncated: false }),
      sampleTable: vi.fn().mockResolvedValue({ rows: [], returnedRows: 0, truncated: false }),
    } as unknown as FabricDataService;
    const workflow = new McpWorkflowService(semanticModels, fabric, powerBi, fabricData, {
      maxDaxRows: 100,
      maxResponseBytes: 65_536,
      maxDataResponseBytes: 65_536,
      readOnly: false,
    });
    testServer = await startTestHttpServer(workflow);
    client = new Client({ name: "workflow-e2e", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
        authProvider: { token: () => Promise.resolve(TEST_API_KEY) },
      }),
    );

    const ids = { workspaceId: WORKSPACE_ID, semanticModelId: MODEL_ID };
    const calls: ReadonlyArray<{
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }> = [
      { name: "list_workspaces", arguments: {} },
      { name: "list_semantic_models", arguments: { workspaceId: WORKSPACE_ID } },
      { name: "list_lakehouses", arguments: { workspaceId: WORKSPACE_ID } },
      {
        name: "get_lakehouse",
        arguments: { workspaceId: WORKSPACE_ID, lakehouseId: MODEL_ID },
      },
      {
        name: "list_lakehouse_tables",
        arguments: { workspaceId: WORKSPACE_ID, lakehouseId: MODEL_ID },
      },
      { name: "list_warehouses", arguments: { workspaceId: WORKSPACE_ID } },
      {
        name: "get_warehouse",
        arguments: { workspaceId: WORKSPACE_ID, warehouseId: MODEL_ID },
      },
      {
        name: "inspect_data_source_schema",
        arguments: {
          workspaceId: WORKSPACE_ID,
          itemType: "lakehouse",
          itemId: MODEL_ID,
        },
      },
      {
        name: "sample_data_source_table",
        arguments: {
          workspaceId: WORKSPACE_ID,
          itemType: "warehouse",
          itemId: MODEL_ID,
          schemaName: "dbo",
          tableName: "Sales",
        },
      },
      { name: "get_semantic_model", arguments: ids },
      { name: "get_semantic_model_definition", arguments: ids },
      { name: "get_model_info", arguments: ids },
      {
        name: "create_semantic_model",
        arguments: { workspaceId: WORKSPACE_ID, displayName: "Preview", model },
      },
      {
        name: "update_semantic_model_properties",
        arguments: { ...ids, displayName: "Preview" },
      },
      {
        name: "apply_model_changes",
        arguments: {
          ...ids,
          expectedDefinitionHash: snapshot.definitionHash,
          operations: [
            {
              action: "delete",
              target: { objectType: "measure", parentName: "Sales", name: "Total Sales" },
            },
          ],
        },
      },
      {
        name: "delete_semantic_model",
        arguments: {
          ...ids,
          confirmSemanticModelId: MODEL_ID,
          confirmDisplayName: item.displayName,
          confirmPermanentDelete: true,
        },
      },
      {
        name: "bind_semantic_model_connection",
        arguments: {
          ...ids,
          sourceName: model.dataSources[0]?.name ?? "Source",
          connectionId: TRACKING_ID,
        },
      },
      { name: "validate_dax", arguments: { ...ids, expression: "1" } },
      { name: "execute_dax", arguments: { ...ids, query: 'EVALUATE ROW("Smoke", 1)' } },
      { name: "refresh_semantic_model", arguments: ids },
      { name: "get_refresh_status", arguments: { ...ids, refreshId: TRACKING_ID } },
      { name: "get_operation_status", arguments: { operationId: TRACKING_ID } },
      { name: "model_snapshot", arguments: ids },
      {
        name: "model_diff",
        arguments: { ...ids, proposed: { kind: "model_spec", model } },
      },
      { name: "pre_deploy_gate", arguments: { model } },
    ];

    expect(calls.map((call) => call.name)).toEqual(TOOL_NAMES);
    for (const call of calls) {
      const result = await client.callTool(call);
      expect(result.isError, call.name).not.toBe(true);
      expect(result.structuredContent, call.name).toMatchObject({ ok: true, error: null });
      const text = result.content[0];
      expect(text && text.type === "text" ? JSON.parse(text.text) : undefined, call.name).toEqual(
        result.structuredContent,
      );
    }
  });

  it("redacts successful and failed tool responses without breaking continuation tokens", async () => {
    testServer = await startTestHttpServer({
      execute: (name) => {
        if (name === "get_operation_status") {
          throw new DomainError(
            "EXPECTED_FAILURE",
            `Bearer ${TEST_API_KEY} client_secret=${TEST_API_KEY}`,
          );
        }
        return Promise.resolve({
          status: "success",
          message: `Completed with ${TEST_API_KEY}`,
          data: {
            password: "must-not-leak",
            value: TEST_API_KEY,
            continuationToken: "opaque-page-cursor",
          },
        });
      },
    });
    client = new Client({ name: "workflow-redaction", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
        authProvider: { token: () => Promise.resolve(TEST_API_KEY) },
      }),
    );

    const success = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(JSON.stringify(success)).not.toContain(TEST_API_KEY);
    expect(success.structuredContent).toMatchObject({
      message: "Completed with [REDACTED]",
      data: {
        password: "[REDACTED]",
        value: "[REDACTED]",
        continuationToken: "opaque-page-cursor",
      },
    });

    const failure = await client.callTool({
      name: "get_operation_status",
      arguments: { operationId: TRACKING_ID },
    });
    expect(failure.isError).toBe(true);
    expect(JSON.stringify(failure)).not.toContain(TEST_API_KEY);
    expect(failure.structuredContent).toMatchObject({
      error: { code: "EXPECTED_FAILURE", message: "Bearer [REDACTED] client_secret=[REDACTED]" },
    });
  });
});
