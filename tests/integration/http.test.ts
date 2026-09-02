import { afterEach, describe, expect, it } from "vitest";
import { TEST_API_KEY, startTestHttpServer, type TestHttpServer } from "../helpers/http-server.js";

describe("HTTP boundary", () => {
  let testServer: TestHttpServer | undefined;

  afterEach(async () => {
    await testServer?.close();
    testServer = undefined;
  });

  it("exposes minimal public health and readiness responses", async () => {
    testServer = await startTestHttpServer();

    const health = await fetch(`${testServer.baseUrl}/health`);
    const ready = await fetch(`${testServer.baseUrl}/ready`);

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("x-powered-by")).toBeNull();
    expect(JSON.stringify(await ready.json())).not.toContain(TEST_API_KEY);
  });

  it("rejects missing and invalid MCP bearer credentials identically", async () => {
    testServer = await startTestHttpServer();

    const missing = await fetch(`${testServer.baseUrl}/mcp`, { method: "POST" });
    const invalid = await fetch(`${testServer.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer invalid-token" },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(await missing.json()).toEqual(await invalid.json());
    expect(invalid.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("rejects browser origins outside the allowlist", async () => {
    testServer = await startTestHttpServer();

    const response = await fetch(`${testServer.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_API_KEY}`,
        origin: "https://attacker.example",
      },
    });

    expect(response.status).toBe(403);
  });

  it("allows only POST on the authenticated stateless MCP endpoint", async () => {
    testServer = await startTestHttpServer();

    const response = await fetch(`${testServer.baseUrl}/mcp`, {
      method: "GET",
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });
});
