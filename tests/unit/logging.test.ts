import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../../src/logging.js";

describe("secret redaction", () => {
  it("redacts sensitive keys, bearer headers, assignments, and known secrets", () => {
    const secret = "known-secret-value";
    const value = redact(
      {
        authorization: `Bearer ${secret}`,
        values: [secret, 2, null],
        nested: {
          client_secret: secret,
          message: `request failed password=hunter2 token ${secret}`,
        },
      },
      [secret],
    );

    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("[REDACTED]");
  });

  it("writes one valid JSON object and honors the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "info",
      knownSecrets: ["secret-to-redact"],
      sink: (line) => lines.push(line),
      now: () => new Date("2026-09-02T12:00:00.000Z"),
    });

    logger.debug("not emitted");
    logger.info("request complete", { apiKey: "secret-to-redact", count: 2 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      timestamp: "2026-09-02T12:00:00.000Z",
      level: "info",
      message: "request complete",
      apiKey: "[REDACTED]",
      count: 2,
    });
  });

  it("retains useful Error metadata while removing secrets", () => {
    const secret = "secret-error-value";
    const redacted = redact(new Error(`request failed for Bearer ${secret}`), [secret]);

    expect(redacted).toMatchObject({
      name: "Error",
      message: "request failed for Bearer [REDACTED]",
    });
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});
