import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FabricClient } from "../../src/clients/fabric-client.js";
import { ResilientHttpClient } from "../../src/clients/http-client.js";
import { PowerBiClient } from "../../src/clients/powerbi-client.js";
import type { AccessTokenProvider, TokenAudience } from "../../src/identity.js";
import type { Logger } from "../../src/logging.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MODEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const writeJson = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { "content-type": "application/json", "x-ms-request-id": "fixture" });
  response.end(JSON.stringify(value));
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  request.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.once("end", () => resolve(body));
    request.once("error", reject);
  });
};

describe("Microsoft clients end to end", () => {
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

  it("uses real HTTP, separate audience tokens, pagination, and JSON DAX serialization", async () => {
    const observed: Array<{ authorization: string | undefined; path: string; body: string }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        observed.push({
          authorization: request.headers.authorization,
          path: request.url ?? "",
          body,
        });

        if (request.url === "/v1/workspaces") {
          writeJson(response, 200, {
            value: [{ id: WORKSPACE_ID, displayName: "Development", type: "Workspace" }],
          });
          return;
        }
        if (request.url === `/v1/workspaces/${WORKSPACE_ID}/semanticModels`) {
          writeJson(response, 200, {
            value: [
              {
                id: MODEL_ID,
                displayName: "Sales",
                type: "SemanticModel",
                workspaceId: WORKSPACE_ID,
              },
            ],
          });
          return;
        }
        if (
          request.url === `/v1.0/myorg/groups/${WORKSPACE_ID}/datasets/${MODEL_ID}/executeQueries`
        ) {
          writeJson(response, 200, { results: [{ tables: [{ rows: [{ "[Count]": 1 }] }] }] });
          return;
        }
        writeJson(response, 404, { errorCode: "NotFound" });
      })().catch((error: unknown) => {
        writeJson(response, 500, { message: String(error) });
      });
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
      getAccessToken: vi.fn((audience: TokenAudience) => Promise.resolve(`token-${audience}`)),
    };
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const http = new ResilientHttpClient(tokenProvider, {
      baseUrls: { fabric: baseUrl, powerbi: baseUrl },
      timeoutMs: 1_000,
      maxRetries: 0,
      maxResponseBytes: 100_000,
      logger,
    });
    const fabric = new FabricClient(http, {
      allowedWorkspaceIds: [WORKSPACE_ID],
      readOnly: true,
      maxPages: 10,
    });
    const powerBi = new PowerBiClient(http, {
      allowedWorkspaceIds: [WORKSPACE_ID],
      readOnly: true,
    });

    await expect(fabric.listWorkspaces()).resolves.toHaveLength(1);
    await expect(fabric.listSemanticModels(WORKSPACE_ID)).resolves.toHaveLength(1);
    await expect(
      powerBi.executeDax(WORKSPACE_ID, MODEL_ID, { query: 'EVALUATE ROW("Count", 1)' }),
    ).resolves.toEqual({ results: [{ tables: [{ rows: [{ "[Count]": 1 }] }] }] });

    expect(observed.map((entry) => entry.authorization)).toEqual([
      "Bearer token-fabric",
      "Bearer token-fabric",
      "Bearer token-powerbi",
    ]);
    expect(JSON.parse(observed[2]?.body ?? "{}")).toEqual({
      queries: [{ query: 'EVALUATE ROW("Count", 1)' }],
      serializerSettings: { includeNulls: false },
    });
  });
});
