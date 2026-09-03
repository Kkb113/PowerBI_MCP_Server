import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { FabricClient } from "../../src/clients/fabric-client.js";
import { ResilientHttpClient } from "../../src/clients/http-client.js";
import type { AccessTokenProvider } from "../../src/identity.js";
import type { Logger } from "../../src/logging.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OPERATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const LAKEHOUSE_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const WAREHOUSE_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const workspace = (id = WORKSPACE_ID) => ({
  id,
  displayName: `Workspace ${id.slice(0, 4)}`,
  type: "Workspace",
});

const semanticModel = {
  id: MODEL_ID,
  displayName: "Sales",
  type: "SemanticModel" as const,
  workspaceId: WORKSPACE_ID,
};

const definition = {
  format: "TMSL" as const,
  parts: [{ path: "model.bim", payload: "e30=", payloadType: "InlineBase64" as const }],
};

const jsonResponse = (
  status: number,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const inputUrl = (input: RequestInfo | URL | undefined): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : (input?.url ?? "");
};

const requestBody = (init: RequestInit | undefined): string =>
  typeof init?.body === "string" ? init.body : "";

const createFabricClient = (
  fetchImplementation: typeof fetch,
  options: { readOnly?: boolean; maxPages?: number } = {},
): FabricClient => {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken: () => Promise.resolve("fabric-token"),
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return new FabricClient(
    new ResilientHttpClient(tokenProvider, {
      baseUrls: { fabric: "https://fabric.test", powerbi: "https://powerbi.test" },
      timeoutMs: 100,
      maxRetries: 0,
      maxResponseBytes: 100_000,
      logger,
      fetch: fetchImplementation,
    }),
    {
      readOnly: options.readOnly ?? true,
      maxPages: options.maxPages ?? 10,
    },
  );
};

describe("FabricClient read operations", () => {
  it("paginates every workspace visible to the configured Entra identity", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [workspace(OTHER_WORKSPACE_ID)],
          continuationToken: "next token",
          continuationUri: "https://fabric.test/v1/workspaces?continuationToken=next%20token",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { value: [workspace()] }));
    const client = createFabricClient(fetchMock);

    await expect(client.listWorkspaces()).resolves.toEqual([
      workspace(OTHER_WORKSPACE_ID),
      workspace(),
    ]);
    expect(inputUrl(fetchMock.mock.calls[1]?.[0])).toContain("continuationToken=next+token");
  });

  it("enforces the workspace pagination limit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { value: [], continuationToken: "again" }));
    const client = createFabricClient(fetchMock, { maxPages: 1 });

    await expect(client.listWorkspaces()).rejects.toMatchObject({
      code: "PAGINATION_LIMIT_EXCEEDED",
    });
  });

  it("paginates semantic models and gets one model", async () => {
    const secondModel = { ...semanticModel, id: OPERATION_ID, displayName: "Finance" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, { value: [semanticModel], continuationToken: "page-two" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { value: [secondModel] }))
      .mockResolvedValueOnce(jsonResponse(200, semanticModel, { "request-id": "model-request" }));
    const client = createFabricClient(fetchMock);

    await expect(client.listSemanticModels(WORKSPACE_ID)).resolves.toEqual([
      semanticModel,
      secondModel,
    ]);
    await expect(client.getSemanticModel(WORKSPACE_ID, MODEL_ID)).resolves.toEqual(semanticModel);
  });

  it("enforces the semantic-model pagination limit", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { value: [], continuationToken: "again" }));
    const client = createFabricClient(fetchMock, { maxPages: 1 });

    await expect(client.listSemanticModels(WORKSPACE_ID)).rejects.toMatchObject({
      code: "PAGINATION_LIMIT_EXCEEDED",
    });
  });

  it("returns synchronous and accepted definition reads", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { definition }, { "x-ms-request-id": "sync" }))
      .mockResolvedValueOnce(
        jsonResponse(202, undefined, {
          "x-ms-operation-id": OPERATION_ID,
          location: `https://fabric.test/v1/operations/${OPERATION_ID}`,
          "retry-after": "1",
        }),
      );
    const client = createFabricClient(fetchMock);

    await expect(client.getSemanticModelDefinition(WORKSPACE_ID, MODEL_ID)).resolves.toEqual({
      kind: "completed",
      data: definition,
      requestId: "sync",
    });
    await expect(client.getSemanticModelDefinition(WORKSPACE_ID, MODEL_ID)).resolves.toEqual({
      kind: "accepted",
      operationId: OPERATION_ID,
      location: `https://fabric.test/v1/operations/${OPERATION_ID}`,
      requestId: undefined,
      retryAfterMs: 1_000,
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(inputUrl(fetchMock.mock.calls[0]?.[0])).toContain("format=TMSL");
  });

  it("gets long-running operation state and typed result", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          status: "Succeeded",
          createdTimeUtc: "2026-09-02T12:00:00.1234567",
          lastUpdatedTimeUtc: "2026-09-02T12:00:01.1234567",
          percentComplete: 100,
          error: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { definition }));
    const client = createFabricClient(fetchMock);

    await expect(client.getOperationState(OPERATION_ID)).resolves.toMatchObject({
      status: "Succeeded",
      percentComplete: 100,
    });
    await expect(
      client.getOperationResult(
        OPERATION_ID,
        z.object({ definition: z.object({ format: z.literal("TMSL") }) }),
      ),
    ).resolves.toEqual({ definition: { format: "TMSL" } });
  });

  it("accepts a null operation percentage while Fabric is processing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(200, {
        status: "Running",
        percentComplete: null,
        error: null,
      }),
    );
    const client = createFabricClient(fetchMock);

    await expect(client.getOperationState(OPERATION_ID)).resolves.toMatchObject({
      status: "Running",
      percentComplete: null,
    });
  });

  it("gets connection metadata without returning credentials", async () => {
    const connection = {
      id: OPERATION_ID,
      displayName: "Sales SQL",
      connectivityType: "ShareableCloud",
      connectionDetails: { type: "SQL", path: "server;database" },
      credentialDetails: { credentialType: "ServicePrincipal" },
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, connection));
    const client = createFabricClient(fetchMock);

    await expect(client.getConnection(OPERATION_ID)).resolves.toEqual({
      id: OPERATION_ID,
      displayName: "Sales SQL",
      connectivityType: "ShareableCloud",
      connectionDetails: { type: "SQL", path: "server;database" },
    });
    expect(inputUrl(fetchMock.mock.calls[0]?.[0])).toContain(`/v1/connections/${OPERATION_ID}`);
  });

  it("discovers Lakehouses, their Delta tables, and Warehouses", async () => {
    const lakehouse = {
      id: LAKEHOUSE_ID,
      displayName: "Sales Lakehouse",
      type: "Lakehouse",
      workspaceId: WORKSPACE_ID,
      properties: {
        oneLakeTablesPath: "https://onelake.dfs.fabric.microsoft.com/ws/lh/Tables",
        oneLakeFilesPath: "https://onelake.dfs.fabric.microsoft.com/ws/lh/Files",
        sqlEndpointProperties: {
          connectionString: "abc.datawarehouse.fabric.microsoft.com",
          id: OPERATION_ID,
          provisioningStatus: "Success",
        },
      },
    };
    const table = {
      name: "Sales",
      type: "Managed",
      format: "delta",
      location: "abfss://workspace@onelake.dfs.fabric.microsoft.com/item/Tables/Sales",
    };
    const warehouse = {
      id: WAREHOUSE_ID,
      displayName: "Sales Warehouse",
      type: "Warehouse",
      workspaceId: WORKSPACE_ID,
      properties: {
        connectionString: "xyz.datawarehouse.fabric.microsoft.com",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { value: [lakehouse] }))
      .mockResolvedValueOnce(jsonResponse(200, lakehouse))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [table], continuationToken: null, continuationUri: null }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { value: [warehouse] }))
      .mockResolvedValueOnce(jsonResponse(200, warehouse));
    const client = createFabricClient(fetchMock);

    await expect(client.listLakehouses(WORKSPACE_ID)).resolves.toEqual([lakehouse]);
    await expect(client.getLakehouse(WORKSPACE_ID, LAKEHOUSE_ID)).resolves.toEqual(lakehouse);
    await expect(client.listLakehouseTables(WORKSPACE_ID, LAKEHOUSE_ID)).resolves.toEqual([table]);
    await expect(client.listWarehouses(WORKSPACE_ID)).resolves.toEqual([warehouse]);
    await expect(client.getWarehouse(WORKSPACE_ID, WAREHOUSE_ID)).resolves.toEqual(warehouse);

    const urls = fetchMock.mock.calls.map((call) => inputUrl(call[0]));
    expect(urls[0]).toContain(`/workspaces/${WORKSPACE_ID}/lakehouses`);
    expect(urls[2]).toContain(`/lakehouses/${LAKEHOUSE_ID}/tables`);
    expect(urls[2]).toContain("maxResults=100");
    expect(urls[3]).toContain(`/workspaces/${WORKSPACE_ID}/warehouses`);
  });
});

describe("FabricClient mutation boundary", () => {
  it("creates a model synchronously and never adds an unsafe retry", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(201, semanticModel, { "x-ms-request-id": "created" }));
    const client = createFabricClient(fetchMock, { readOnly: false });

    await expect(
      client.createSemanticModel(WORKSPACE_ID, { displayName: "Sales", definition }),
    ).resolves.toEqual({ kind: "completed", data: semanticModel, requestId: "created" });
    expect(JSON.parse(requestBody(fetchMock.mock.calls[0]?.[1])) as unknown).toEqual({
      displayName: "Sales",
      definition,
    });
  });

  it("returns accepted create and definition-update operations", async () => {
    const acceptedHeaders = {
      "x-ms-operation-id": OPERATION_ID,
      location: `https://fabric.test/v1/operations/${OPERATION_ID}`,
      "x-ms-request-id": "accepted-request",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(202, undefined, acceptedHeaders))
      .mockResolvedValueOnce(jsonResponse(202, undefined, acceptedHeaders));
    const client = createFabricClient(fetchMock, { readOnly: false });

    await expect(
      client.createSemanticModel(WORKSPACE_ID, { displayName: "Sales", definition }),
    ).resolves.toMatchObject({ kind: "accepted", operationId: OPERATION_ID });
    await expect(
      client.updateSemanticModelDefinition(WORKSPACE_ID, MODEL_ID, definition, false),
    ).resolves.toMatchObject({ kind: "accepted", operationId: OPERATION_ID });
    expect(inputUrl(fetchMock.mock.calls[1]?.[0])).toContain("updateMetadata=false");
  });

  it("updates properties and definitions, permanently deletes, and binds one connection", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(200));
    const client = createFabricClient(fetchMock, { readOnly: false });

    await expect(
      client.updateSemanticModel(WORKSPACE_ID, MODEL_ID, {
        displayName: "Renamed",
        description: "Description",
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      client.permanentlyDeleteSemanticModel(WORKSPACE_ID, MODEL_ID),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      client.updateSemanticModelDefinition(WORKSPACE_ID, MODEL_ID, definition),
    ).resolves.toEqual({ kind: "completed", data: undefined, requestId: undefined });
    await expect(
      client.bindSemanticModelConnection(WORKSPACE_ID, MODEL_ID, {
        connectionBinding: {
          id: OPERATION_ID,
          connectivityType: "ShareableCloud",
          connectionDetails: { type: "SQL", path: "server;database" },
        },
      }),
    ).resolves.toMatchObject({ status: 200 });

    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual([
      "PATCH",
      "DELETE",
      "POST",
      "POST",
    ]);
    expect(inputUrl(fetchMock.mock.calls[1]?.[0])).toContain("hardDelete=true");
    expect(inputUrl(fetchMock.mock.calls[3]?.[0])).toContain("bindConnection");
  });

  it("blocks all mutations in read-only mode before making HTTP calls", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createFabricClient(fetchMock);

    await expect(
      client.createSemanticModel(WORKSPACE_ID, { displayName: "Sales", definition }),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(
      client.updateSemanticModel(WORKSPACE_ID, MODEL_ID, { displayName: "Renamed" }),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(
      client.permanentlyDeleteSemanticModel(WORKSPACE_ID, MODEL_ID),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(
      client.updateSemanticModelDefinition(WORKSPACE_ID, MODEL_ID, definition),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    await expect(
      client.bindSemanticModelConnection(WORKSPACE_ID, MODEL_ID, {
        connectionBinding: {
          id: OPERATION_ID,
          connectivityType: "ShareableCloud",
          connectionDetails: { type: "SQL", path: "server" },
        },
      }),
    ).rejects.toMatchObject({ code: "READ_ONLY_VIOLATION" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid IDs, bad inputs, and incomplete 202 responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(202));
    const client = createFabricClient(fetchMock, { readOnly: false });

    await expect(client.getSemanticModel("not-a-uuid", MODEL_ID)).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
    });
    await expect(client.getSemanticModel(WORKSPACE_ID, "invalid")).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
    });
    await expect(client.updateSemanticModel(WORKSPACE_ID, MODEL_ID, {})).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      client.createSemanticModel(WORKSPACE_ID, { displayName: "", definition }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      client.createSemanticModel(WORKSPACE_ID, { displayName: "Sales", definition }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(client.getOperationState("bad")).rejects.toMatchObject({
      code: "INVALID_IDENTIFIER",
    });
  });

  it("rejects missing successful response bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200));
    const client = createFabricClient(fetchMock);

    await expect(client.getSemanticModel(WORKSPACE_ID, MODEL_ID)).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });
});
