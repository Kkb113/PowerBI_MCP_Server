import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { RESOURCE_REGISTRY, TOOL_NAMES } from "../../src/mcp/registry.js";
import { TEST_API_KEY, startTestHttpServer, type TestHttpServer } from "../helpers/http-server.js";

describe("remote MCP end to end", () => {
  let testServer: TestHttpServer | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await testServer?.close();
    client = undefined;
    testServer = undefined;
  });

  it("initializes, discovers the frozen contract, reads resources, and invokes a placeholder", async () => {
    testServer = await startTestHttpServer();
    const transport = new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
      authProvider: { token: () => Promise.resolve(TEST_API_KEY) },
    });
    client = new Client({ name: "phase-one-e2e", version: "1.0.0" });

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
      phase: 1,
      implementationStatus: "contract_only",
      fabricMutationEnabled: false,
    });

    const result = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      status: "not_implemented",
      error: { code: "NOT_IMPLEMENTED", retryable: false },
    });
  });
});
