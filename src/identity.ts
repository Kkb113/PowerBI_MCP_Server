import type { AccessToken, TokenCredential } from "@azure/core-auth";
import { ClientSecretCredential, DefaultAzureCredential } from "@azure/identity";
import type { AppConfig } from "./config.js";
import { ApiError, type ExternalService } from "./clients/errors.js";

export const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
export const POWERBI_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

export type TokenAudience = "fabric" | "powerbi";

export interface AccessTokenProvider {
  getAccessToken(audience: TokenAudience): Promise<string>;
}

export interface AccessTokenProviderOptions {
  readonly refreshOffsetMs?: number;
  readonly now?: () => number;
}

const audienceScope: Readonly<Record<TokenAudience, string>> = {
  fabric: FABRIC_SCOPE,
  powerbi: POWERBI_SCOPE,
};

const audienceService: Readonly<Record<TokenAudience, ExternalService>> = {
  fabric: "fabric",
  powerbi: "powerbi",
};

export function createAzureCredential(config: AppConfig["azure"]): TokenCredential {
  if (config.mode === "client-secret") {
    if (!config.tenantId || !config.clientId || !config.clientSecret) {
      throw new ApiError(
        "INVALID_AUTH_CONFIGURATION",
        "Client-secret authentication requires tenant, client, and secret configuration.",
        { service: "azure-identity", operation: "create_credential" },
      );
    }
    return new ClientSecretCredential(config.tenantId, config.clientId, config.clientSecret);
  }

  return new DefaultAzureCredential({
    ...(config.tenantId ? { tenantId: config.tenantId } : {}),
    ...(config.clientId
      ? { managedIdentityClientId: config.clientId, workloadIdentityClientId: config.clientId }
      : {}),
  });
}

export class CachedAccessTokenProvider implements AccessTokenProvider {
  private readonly cache = new Map<TokenAudience, AccessToken>();
  private readonly pending = new Map<TokenAudience, Promise<string>>();
  private readonly refreshOffsetMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly credential: TokenCredential,
    options: AccessTokenProviderOptions = {},
  ) {
    this.refreshOffsetMs = options.refreshOffsetMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  public async getAccessToken(audience: TokenAudience): Promise<string> {
    const cached = this.cache.get(audience);
    if (cached && this.isUsable(cached)) {
      return cached.token;
    }

    const inFlight = this.pending.get(audience);
    if (inFlight) {
      return await inFlight;
    }

    const acquisition = this.acquire(audience);
    this.pending.set(audience, acquisition);

    try {
      return await acquisition;
    } finally {
      this.pending.delete(audience);
    }
  }

  public clear(audience?: TokenAudience): void {
    if (audience) {
      this.cache.delete(audience);
    } else {
      this.cache.clear();
    }
  }

  private isUsable(token: AccessToken): boolean {
    const refreshAt =
      token.refreshAfterTimestamp ?? token.expiresOnTimestamp - this.refreshOffsetMs;
    return token.token.length > 0 && this.now() < refreshAt;
  }

  private async acquire(audience: TokenAudience): Promise<string> {
    try {
      const token = await this.credential.getToken(audienceScope[audience]);
      if (!token || token.token.length === 0 || token.expiresOnTimestamp <= this.now()) {
        throw new Error("Credential returned no usable access token.");
      }
      this.cache.set(audience, token);
      return token.token;
    } catch (error: unknown) {
      throw new ApiError(
        "TOKEN_ACQUISITION_FAILED",
        `Failed to acquire a ${audience} access token.`,
        {
          service: audienceService[audience],
          operation: "acquire_access_token",
          retryable: true,
          cause: error,
        },
      );
    }
  }
}
