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
    expect(config.apiKey).toBe(apiKey);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("adds the Render hostname and removes duplicate allowlist entries", () => {
    const config = loadConfig({
      MCP_API_KEY: apiKey,
      MCP_ALLOWED_HOSTS: "localhost,api.example.test,localhost",
      MCP_ALLOWED_ORIGINS: "app.example.test",
      RENDER_EXTERNAL_HOSTNAME: "service.onrender.com",
    });

    expect(config.allowedHosts).toEqual(["localhost", "api.example.test", "service.onrender.com"]);
    expect(config.allowedOrigins).toEqual(["app.example.test"]);
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
