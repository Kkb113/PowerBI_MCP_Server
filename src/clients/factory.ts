import type { TokenCredential } from "@azure/core-auth";
import type { AppConfig } from "../config.js";
import { CachedAccessTokenProvider, createAzureCredential } from "../identity.js";
import type { Logger } from "../logging.js";
import { FabricClient, FABRIC_API_BASE_URL } from "./fabric-client.js";
import { ResilientHttpClient } from "./http-client.js";
import { PowerBiClient, POWERBI_API_BASE_URL } from "./powerbi-client.js";

export interface MicrosoftApiClients {
  readonly fabric: FabricClient;
  readonly powerBi: PowerBiClient;
}

export function createMicrosoftApiClients(
  config: AppConfig,
  logger: Logger,
  credential: TokenCredential = createAzureCredential(config.azure),
): MicrosoftApiClients {
  const tokenProvider = new CachedAccessTokenProvider(credential);
  const http = new ResilientHttpClient(tokenProvider, {
    baseUrls: {
      fabric: FABRIC_API_BASE_URL,
      powerbi: POWERBI_API_BASE_URL,
    },
    timeoutMs: config.http.timeoutMs,
    maxRetries: config.http.maxRetries,
    maxResponseBytes: config.http.maxResponseBytes,
    logger,
  });

  return {
    fabric: new FabricClient(http, {
      allowedWorkspaceIds: config.allowedWorkspaceIds,
      readOnly: config.readOnly,
      maxPages: config.http.maxPages,
    }),
    powerBi: new PowerBiClient(http, {
      allowedWorkspaceIds: config.allowedWorkspaceIds,
      readOnly: config.readOnly,
    }),
  };
}
