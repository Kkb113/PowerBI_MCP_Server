import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { TOOL_NAMES } from "../../src/mcp/registry.js";
import { startTestHttpServer, type TestHttpServer } from "../helpers/http-server.js";

describe("OAuth-authenticated MCP transport", () => {
  let testServer: TestHttpServer | undefined;
  let jwksServer: Server | undefined;

  afterEach(async () => {
    await testServer?.close();
    testServer = undefined;
    await new Promise<void>((resolve, reject) => {
      if (!jwksServer) {
        resolve();
        return;
      }
      jwksServer.close((error) => (error ? reject(error) : resolve()));
    });
    jwksServer = undefined;
  });

  it("initializes and discovers tools through the standard Streamable HTTP client", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "https://mcp.example.test",
      MCP_OAUTH_ISSUER_URL: "https://identity.example.test",
      MCP_OAUTH_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
      MCP_OAUTH_AUDIENCE: "https://mcp.example.test/mcp",
      MCP_OAUTH_REQUIRED_SCOPES: "fabric.access",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    });
    testServer = await startTestHttpServer(undefined, {
      config,
      oauthTokenVerifier: () => Promise.resolve({ scope: "fabric.access" }),
    });
    const client = new Client({ name: "oauth-interoperability-test", version: "1.0.0" });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
          authProvider: { token: () => Promise.resolve("valid-access-token") },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    } finally {
      await client.close();
    }
  });

  it("verifies a signed JWT against the configured remote JWKS", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const publicJwk = await exportJWK(publicKey);
    const keyId = "mcp-test-signing-key";
    jwksServer = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ keys: [{ ...publicJwk, alg: "RS256", kid: keyId, use: "sig" }] }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      jwksServer!.once("error", reject);
      jwksServer!.listen(0, "127.0.0.1", () => {
        jwksServer!.off("error", reject);
        resolve();
      });
    });
    const jwksAddress = jwksServer.address() as AddressInfo;
    const issuer = `http://127.0.0.1:${jwksAddress.port}`;
    const audience = "fabric-semantic-model-mcp-test";
    const accessToken = await new SignJWT({ scope: "fabric.access" })
      .setProtectedHeader({ alg: "RS256", kid: keyId })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_ISSUER_URL: issuer,
      MCP_OAUTH_JWKS_URL: `${issuer}/jwks.json`,
      MCP_OAUTH_AUDIENCE: audience,
      MCP_OAUTH_REQUIRED_SCOPES: "fabric.access",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    });
    testServer = await startTestHttpServer(undefined, { config });
    const client = new Client({ name: "signed-jwt-test", version: "1.0.0" });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${testServer.baseUrl}/mcp`), {
          authProvider: { token: () => Promise.resolve(accessToken) },
        }),
      );
      expect((await client.listTools()).tools).toHaveLength(TOOL_NAMES.length);
    } finally {
      await client.close();
    }
  });
});
