import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
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

  it("publishes standard OAuth resource metadata and returns actionable bearer challenges", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "https://mcp.example.test",
      MCP_OAUTH_ISSUER_URL: "https://identity.example.test",
      MCP_OAUTH_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
      MCP_OAUTH_AUDIENCE: "https://mcp.example.test/mcp",
      MCP_OAUTH_REQUIRED_SCOPES: "fabric.read,fabric.write",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    });
    testServer = await startTestHttpServer(undefined, {
      config,
      oauthTokenVerifier: (token) => {
        if (token === "valid-token") {
          return Promise.resolve({ scope: "fabric.read fabric.write" });
        }
        if (token === "limited-token") {
          return Promise.resolve({ scope: "fabric.read" });
        }
        return Promise.reject(new Error("invalid test token"));
      },
    });

    const rootMetadata = await fetch(`${testServer.baseUrl}/.well-known/oauth-protected-resource`);
    const pathMetadata = await fetch(
      `${testServer.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    const expectedMetadata = {
      resource: "https://mcp.example.test/mcp",
      authorization_servers: ["https://identity.example.test"],
      scopes_supported: ["fabric.read", "fabric.write"],
      bearer_methods_supported: ["header"],
    };

    expect(rootMetadata.status).toBe(200);
    expect(await rootMetadata.json()).toEqual(expectedMetadata);
    expect(await pathMetadata.json()).toEqual(expectedMetadata);

    const missing = await fetch(`${testServer.baseUrl}/mcp`, { method: "POST" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp", scope="fabric.read fabric.write"',
    );

    const invalid = await fetch(`${testServer.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const insufficient = await fetch(`${testServer.baseUrl}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer limited-token" },
    });
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });
});
