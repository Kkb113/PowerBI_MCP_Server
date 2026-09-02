import type { AccessToken, GetTokenOptions, TokenCredential } from "@azure/core-auth";
import { describe, expect, it, vi } from "vitest";
import { FabricClient } from "../../src/clients/fabric-client.js";
import { createMicrosoftApiClients } from "../../src/clients/factory.js";
import { PowerBiClient } from "../../src/clients/powerbi-client.js";
import type { Logger } from "../../src/logging.js";
import { TEST_CONFIG } from "../helpers/http-server.js";

class UnusedCredential implements TokenCredential {
  public readonly getToken =
    vi.fn<(scopes: string | string[], options?: GetTokenOptions) => Promise<AccessToken | null>>();
}

describe("createMicrosoftApiClients", () => {
  it("constructs both clients around one configured authentication boundary", () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const clients = createMicrosoftApiClients(TEST_CONFIG, logger, new UnusedCredential());

    expect(clients.fabric).toBeInstanceOf(FabricClient);
    expect(clients.powerBi).toBeInstanceOf(PowerBiClient);
  });
});
