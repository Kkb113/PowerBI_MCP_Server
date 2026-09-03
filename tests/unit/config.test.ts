import { describe, expect, it } from "vitest";
import { ConfigurationError, loadConfig } from "../../src/config.js";

const apiKey = "a-secure-test-key-with-32-characters";

describe("loadConfig", () => {
  it("loads secure defaults without exposing the API key", () => {
    const config = loadConfig({ MCP_API_KEY: apiKey });

    expect(config).toMatchObject({
      nodeEnv: "development",
      host: "0.0.0.0",
      port: 3_000,
      logLevel: "info",
    });
    expect(config.allowedHosts).toEqual(["localhost", "127.0.0.1", "[::1]"]);
    expect(config.allowedOrigins).toEqual(config.allowedHosts);
    expect(config.auth).toEqual({ mode: "api-key", apiKey });
    expect(config.azure).toEqual({ mode: "default" });
    expect(config.readOnly).toBe(true);
    expect(config.http).toEqual({
      timeoutMs: 30_000,
      maxRetries: 2,
      maxPages: 100,
      maxResponseBytes: 10_485_760,
    });
    expect(config.lroPollBudgetMs).toBe(60_000);
    expect(config.dax).toEqual({ maxRows: 1_000, maxResponseBytes: 1_048_576 });
    expect(config.data).toEqual({ maxRows: 100, maxResponseBytes: 1_048_576 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("uses the portable public origin for the API-key host allowlist", () => {
    const config = loadConfig({
      MCP_API_KEY: apiKey,
      MCP_PUBLIC_BASE_URL: "https://temporary-host.example.test",
    });

    expect(config.allowedHosts).toContain("temporary-host.example.test");
  });

  it("loads client-secret authentication and bounded HTTP and data controls", () => {
    const config = loadConfig({
      MCP_API_KEY: apiKey,
      AZURE_AUTH_MODE: "client-secret",
      AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
      AZURE_CLIENT_SECRET: "credential",
      POWERBI_MCP_READONLY: "false",
      HTTP_TIMEOUT_MS: "5000",
      HTTP_MAX_RETRIES: "3",
      HTTP_MAX_PAGES: "25",
      HTTP_MAX_RESPONSE_BYTES: "2048",
      LRO_POLL_BUDGET_MS: "45000",
      DAX_MAX_ROWS: "250",
      DAX_MAX_RESPONSE_BYTES: "4096",
      DATA_MAX_ROWS: "50",
      DATA_MAX_RESPONSE_BYTES: "8192",
    });

    expect(config.azure).toEqual({
      mode: "client-secret",
      tenantId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      clientSecret: "credential",
    });
    expect(config.readOnly).toBe(false);
    expect(config.http).toEqual({
      timeoutMs: 5_000,
      maxRetries: 3,
      maxPages: 25,
      maxResponseBytes: 2_048,
    });
    expect(config.lroPollBudgetMs).toBe(45_000);
    expect(config.dax).toEqual({ maxRows: 250, maxResponseBytes: 4_096 });
    expect(config.data).toEqual({ maxRows: 50, maxResponseBytes: 8_192 });
  });

  it("requires complete client-secret settings without requiring a workspace ID", () => {
    expect(() =>
      loadConfig({
        MCP_API_KEY: apiKey,
        AZURE_AUTH_MODE: "client-secret",
        AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrowError(ConfigurationError);
    expect(() =>
      loadConfig({
        MCP_API_KEY: apiKey,
        AZURE_AUTH_MODE: "auto",
        AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
        AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
        AZURE_CLIENT_SECRET: "credential",
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        MCP_API_KEY: apiKey,
        AZURE_AUTH_MODE: "client-secret",
        AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
        AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
        AZURE_CLIENT_SECRET: "credential",
      }),
    ).not.toThrow();
  });

  it("loads portable OAuth resource-server settings and derives the public MCP URLs", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "https://mcp.example.test/",
      MCP_OAUTH_ISSUER_URL: "https://identity.example.test/",
      MCP_OAUTH_JWKS_URL: "https://identity.example.test/.well-known/jwks.json",
      MCP_OAUTH_AUDIENCE: "https://mcp.example.test/mcp",
      MCP_OAUTH_REQUIRED_SCOPES: "fabric.read,fabric.write,fabric.read",
      MCP_ALLOWED_HOSTS: "localhost,api.example.test,localhost",
      MCP_ALLOWED_ORIGINS: "app.example.test",
    });

    expect(config.auth).toEqual({
      mode: "oauth",
      publicBaseUrl: "https://mcp.example.test",
      resourceUrl: "https://mcp.example.test/mcp",
      protectedResourceMetadataUrl:
        "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      issuerUrl: "https://identity.example.test/",
      jwksUrl: "https://identity.example.test/.well-known/jwks.json",
      audience: "https://mcp.example.test/mcp",
      requiredScopes: ["fabric.read", "fabric.write"],
    });
    expect(config.allowedHosts).toEqual(["localhost", "api.example.test", "mcp.example.test"]);
    expect(config.allowedOrigins).toEqual(["app.example.test"]);
  });

  it("requires complete OAuth settings and secure production URLs", () => {
    expect(() => loadConfig({ MCP_AUTH_MODE: "oauth" })).toThrowError(ConfigurationError);
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MCP_AUTH_MODE: "oauth",
        MCP_PUBLIC_BASE_URL: "http://mcp.example.test",
        MCP_OAUTH_ISSUER_URL: "https://identity.example.test",
        MCP_OAUTH_JWKS_URL: "https://identity.example.test/jwks",
        MCP_OAUTH_AUDIENCE: "mcp-api",
        MCP_OAUTH_REQUIRED_SCOPES: "fabric.read",
      }),
    ).toThrowError(ConfigurationError);
  });

  it("fails fast with field names but without configured values", () => {
    const invalidSecret = "too-short";

    expect(() => loadConfig({ MCP_API_KEY: invalidSecret, PORT: "70000" })).toThrowError(
      ConfigurationError,
    );

    try {
      loadConfig({ MCP_API_KEY: invalidSecret, PORT: "70000" });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(String(error)).toContain("MCP_API_KEY");
      expect(String(error)).toContain("PORT");
      expect(String(error)).not.toContain(invalidSecret);
    }
  });
});
