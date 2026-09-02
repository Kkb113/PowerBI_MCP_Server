import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricClient } from "../../src/clients/fabric-client.js";
import { ResilientHttpClient } from "../../src/clients/http-client.js";
import type { SemanticModel, SemanticModelDefinition } from "../../src/clients/schemas.js";
import type { AccessTokenProvider } from "../../src/identity.js";
import { hashModelSpec } from "../../src/model/index.js";
import { SemanticModelService } from "../../src/services/index.js";
import type { Logger } from "../../src/logging.js";
import { loadModelFixture } from "../helpers/model.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONNECTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  return body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>);
};

const sendJson = (response: ServerResponse, status: number, body?: unknown): void => {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-ms-request-id": "phase-4-fixture",
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
};

const requiredString = (body: Readonly<Record<string, unknown>>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`Expected '${key}' to be a string.`);
  return value;
};

const representativeChanges: readonly unknown[] = [
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
      description: "Representative Phase 4 measure.",
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

describe("semantic model lifecycle end to end", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        async (server) =>
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("creates, reads, mutates, binds, verifies, and permanently deletes through real HTTP", async () => {
    let item: SemanticModel | undefined;
    let definition: SemanticModelDefinition | undefined;
    let active = false;
    let bindingCount = 0;
    let definitionUpdateCount = 0;
    let observedHardDelete: string | null = null;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "http://fixture.test");
        const modelsPath = `/v1/workspaces/${WORKSPACE_ID}/semanticModels`;
        const modelPath = `${modelsPath}/${MODEL_ID}`;

        if (request.method === "POST" && url.pathname === modelsPath) {
          const body = await readJson(request);
          definition = body["definition"] as SemanticModelDefinition;
          item = {
            id: MODEL_ID,
            displayName: requiredString(body, "displayName"),
            description: requiredString(body, "description"),
            type: "SemanticModel",
            workspaceId: WORKSPACE_ID,
          };
          active = true;
          sendJson(response, 201, item);
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/workspaces") {
          sendJson(response, 200, {
            value: [{ id: WORKSPACE_ID, displayName: "Development", type: "Workspace" }],
          });
          return;
        }
        if (request.method === "GET" && url.pathname === modelsPath) {
          sendJson(response, 200, { value: active && item ? [item] : [] });
          return;
        }
        if (request.method === "GET" && url.pathname === modelPath && active && item) {
          sendJson(response, 200, item);
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === `${modelPath}/getDefinition` &&
          active &&
          definition
        ) {
          expect(url.searchParams.get("format")).toBe("TMSL");
          sendJson(response, 200, { definition });
          return;
        }
        if (request.method === "PATCH" && url.pathname === modelPath && active && item) {
          const body = await readJson(request);
          item = {
            ...item,
            ...(body["displayName"] === undefined
              ? {}
              : { displayName: requiredString(body, "displayName") }),
            ...(body["description"] === undefined
              ? {}
              : { description: requiredString(body, "description") }),
          };
          sendJson(response, 200, item);
          return;
        }
        if (
          request.method === "POST" &&
          url.pathname === `${modelPath}/updateDefinition` &&
          active
        ) {
          const body = await readJson(request);
          definition = body["definition"] as SemanticModelDefinition;
          definitionUpdateCount += 1;
          sendJson(response, 200);
          return;
        }
        if (request.method === "GET" && url.pathname === `/v1/connections/${CONNECTION_ID}`) {
          sendJson(response, 200, {
            id: CONNECTION_ID,
            displayName: "Warehouse SQL",
            connectivityType: "ShareableCloud",
            connectionDetails: {
              type: "SQL",
              path: "example.datawarehouse.fabric.microsoft.com;SalesWarehouse",
            },
            credentialDetails: { credentialType: "ServicePrincipal" },
          });
          return;
        }
        if (request.method === "POST" && url.pathname === `${modelPath}/bindConnection`) {
          const body = await readJson(request);
          expect(body).toMatchObject({
            connectionBinding: { id: CONNECTION_ID, connectivityType: "ShareableCloud" },
          });
          bindingCount += 1;
          sendJson(response, 200);
          return;
        }
        if (request.method === "DELETE" && url.pathname === modelPath) {
          observedHardDelete = url.searchParams.get("hardDelete");
          active = false;
          sendJson(response, 200);
          return;
        }
        sendJson(response, 404, { errorCode: "ItemNotFound", message: "Not found" });
      })().catch((error: unknown) => sendJson(response, 500, { message: String(error) }));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const tokenProvider: AccessTokenProvider = {
      getAccessToken: vi.fn(() => Promise.resolve("fabric-token")),
    };
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fabric = new FabricClient(
      new ResilientHttpClient(tokenProvider, {
        baseUrls: { fabric: baseUrl, powerbi: baseUrl },
        timeoutMs: 1_000,
        maxRetries: 0,
        maxResponseBytes: 1_000_000,
        logger,
      }),
      { allowedWorkspaceIds: [WORKSPACE_ID], readOnly: false, maxPages: 10 },
    );
    const service = new SemanticModelService(fabric, { lroPollBudgetMs: 1_000 });
    const initial = loadModelFixture();

    const preview = await service.createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Phase 4 E2E",
      model: initial,
    });
    expect(preview.status).toBe("preview");
    expect(active).toBe(false);

    const created = await service.createSemanticModel({
      workspaceId: WORKSPACE_ID,
      displayName: "Phase 4 E2E",
      description: "Disposable local fixture",
      model: initial,
      apply: true,
    });
    expect(created).toMatchObject({ status: "completed", applied: true });
    expect((await service.listWorkspaces()).value).toHaveLength(1);
    expect((await service.listSemanticModels(WORKSPACE_ID)).value).toHaveLength(1);

    const renamed = await service.updateSemanticModelProperties({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      displayName: "Phase 4 E2E Updated",
      description: "Updated metadata",
      apply: true,
    });
    expect(renamed).toMatchObject({
      status: "completed",
      item: { displayName: "Phase 4 E2E Updated" },
    });

    const mutation = await service.applyModelChanges({
      workspaceId: WORKSPACE_ID,
      semanticModelId: MODEL_ID,
      expectedDefinitionHash: hashModelSpec(initial),
      operations: representativeChanges,
      apply: true,
    });
    expect(mutation).toMatchObject({
      status: "completed",
      applied: true,
      summary: {
        counts: {
          tables: initial.tables.length + 2,
          relationships: initial.relationships.length + 1,
          calculationGroups: initial.calculationGroups.length + 1,
          roles: initial.roles.length + 1,
        },
      },
    });
    expect(definitionUpdateCount).toBe(1);
    if (!("definitionHash" in mutation)) throw new Error("Expected a completed mutation");
    const snapshot = await service.getSnapshot(WORKSPACE_ID, MODEL_ID);
    expect(snapshot).toMatchObject({
      status: "completed",
      snapshot: { definitionHash: mutation.definitionHash },
    });

    await expect(
      service.applyModelChanges({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        expectedDefinitionHash: hashModelSpec(initial),
        operations: [representativeChanges[0]],
        apply: true,
      }),
    ).rejects.toMatchObject({ code: "STALE_DEFINITION_HASH" });
    expect(definitionUpdateCount).toBe(1);

    await expect(
      service.bindSemanticModelConnection({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        sourceName: "Warehouse Source",
        connectionId: CONNECTION_ID,
        apply: true,
      }),
    ).resolves.toMatchObject({ status: "completed", applied: true });
    expect(bindingCount).toBe(1);

    await expect(
      service.deleteSemanticModel({
        workspaceId: WORKSPACE_ID,
        semanticModelId: MODEL_ID,
        confirmSemanticModelId: MODEL_ID,
        confirmDisplayName: "Phase 4 E2E Updated",
        confirmPermanentDelete: true,
        apply: true,
      }),
    ).resolves.toMatchObject({ status: "completed", hardDelete: true, irreversible: true });
    expect(observedHardDelete).toBe("true");
    expect((await service.listSemanticModels(WORKSPACE_ID)).value).toEqual([]);
  });
});
