import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startHttpServer } from "../../src/http/server.js";
import { createLogger } from "../../src/logging.js";
import { TEST_CONFIG } from "../helpers/http-server.js";

describe("HTTP process startup", () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await closeServer?.();
    closeServer = undefined;
  });

  it("binds through the production startup path and reports health", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info", sink: (line) => lines.push(line) });
    const server = await startHttpServer(TEST_CONFIG, logger);
    closeServer = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://${TEST_CONFIG.host}:${address.port}/health`);

    expect(response.status).toBe(200);
    expect(lines.some((line) => line.includes('"message":"HTTP server started"'))).toBe(true);
  });
});
