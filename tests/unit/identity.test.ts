import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/core-auth";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/clients/errors.js";
import {
  CachedAccessTokenProvider,
  createAzureCredential,
  FABRIC_SCOPE,
  FABRIC_SQL_SCOPE,
  POWERBI_SCOPE,
} from "../../src/identity.js";

class StubCredential implements TokenCredential {
  public readonly getToken =
    vi.fn<(scopes: string | string[], options?: GetTokenOptions) => Promise<AccessToken | null>>();
}

const token = (
  value: string,
  expiresOnTimestamp: number,
  refreshAfterTimestamp?: number,
): AccessToken => ({
  token: value,
  expiresOnTimestamp,
  ...(refreshAfterTimestamp === undefined ? {} : { refreshAfterTimestamp }),
});

describe("Azure credential creation", () => {
  it("creates the selected Azure Identity credential", () => {
    expect(
      createAzureCredential({
        mode: "client-secret",
        tenantId: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
        clientSecret: "secret",
      }),
    ).toBeInstanceOf(ClientSecretCredential);
    expect(createAzureCredential({ mode: "default" })).toBeInstanceOf(DefaultAzureCredential);
    expect(
      createAzureCredential({
        mode: "default",
        tenantId: "11111111-1111-4111-8111-111111111111",
        clientId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBeInstanceOf(DefaultAzureCredential);
  });

  it("rejects an incomplete explicit client-secret configuration", () => {
    expect(() => createAzureCredential({ mode: "client-secret" })).toThrowError(
      expect.objectContaining({ code: "INVALID_AUTH_CONFIGURATION" }),
    );
  });
});

describe("CachedAccessTokenProvider", () => {
  it("uses distinct scopes and caches each audience independently", async () => {
    const credential = new StubCredential();
    credential.getToken.mockImplementation((scope) =>
      Promise.resolve(token(String(scope), 1_000_000, 900_000)),
    );
    const provider = new CachedAccessTokenProvider(credential, { now: () => 100_000 });

    await expect(provider.getAccessToken("fabric")).resolves.toBe(FABRIC_SCOPE);
    await expect(provider.getAccessToken("fabric")).resolves.toBe(FABRIC_SCOPE);
    await expect(provider.getAccessToken("fabric-sql")).resolves.toBe(FABRIC_SQL_SCOPE);
    await expect(provider.getAccessToken("powerbi")).resolves.toBe(POWERBI_SCOPE);
    expect(credential.getToken).toHaveBeenCalledTimes(3);
    expect(credential.getToken).toHaveBeenNthCalledWith(1, FABRIC_SCOPE);
    expect(credential.getToken).toHaveBeenNthCalledWith(2, FABRIC_SQL_SCOPE);
    expect(credential.getToken).toHaveBeenNthCalledWith(3, POWERBI_SCOPE);
  });

  it("deduplicates concurrent acquisition and supports targeted and full cache clearing", async () => {
    const credential = new StubCredential();
    let release: ((value: AccessToken) => void) | undefined;
    credential.getToken.mockImplementation(
      async () =>
        await new Promise<AccessToken>((resolve) => {
          release = resolve;
        }),
    );
    const provider = new CachedAccessTokenProvider(credential, { now: () => 1_000 });

    const first = provider.getAccessToken("fabric");
    const second = provider.getAccessToken("fabric");
    release?.(token("shared", 100_000));
    await expect(Promise.all([first, second])).resolves.toEqual(["shared", "shared"]);
    expect(credential.getToken).toHaveBeenCalledTimes(1);

    credential.getToken.mockResolvedValue(token("renewed", 100_000));
    provider.clear("fabric");
    await expect(provider.getAccessToken("fabric")).resolves.toBe("renewed");
    provider.clear();
    await expect(provider.getAccessToken("fabric")).resolves.toBe("renewed");
    expect(credential.getToken).toHaveBeenCalledTimes(3);
  });

  it("refreshes close-to-expiry tokens and wraps unusable or failed acquisitions", async () => {
    const credential = new StubCredential();
    credential.getToken
      .mockResolvedValueOnce(token("old", 120_000))
      .mockResolvedValueOnce(token("new", 500_000));
    let now = 1_000;
    const provider = new CachedAccessTokenProvider(credential, {
      now: () => now,
      refreshOffsetMs: 10_000,
    });

    await expect(provider.getAccessToken("fabric")).resolves.toBe("old");
    now = 115_000;
    await expect(provider.getAccessToken("fabric")).resolves.toBe("new");

    credential.getToken.mockResolvedValueOnce(null);
    provider.clear("powerbi");
    await expect(provider.getAccessToken("powerbi")).rejects.toMatchObject({
      code: "TOKEN_ACQUISITION_FAILED",
      service: "powerbi",
      retryable: true,
    });

    credential.getToken.mockRejectedValueOnce(new Error("credential secret must not surface"));
    provider.clear("fabric");
    const failure = await provider.getAccessToken("fabric").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(String(failure)).not.toContain("credential secret must not surface");
  });
});
