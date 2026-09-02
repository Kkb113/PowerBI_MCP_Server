import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../../src/clients/errors.js";
import { ResilientHttpClient } from "../../src/clients/http-client.js";
import type { AccessTokenProvider } from "../../src/identity.js";
import type { Logger } from "../../src/logging.js";

const jsonHeaders = { "content-type": "application/json" };

const response = (
  status: number,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { ...jsonHeaders, ...headers },
  });

const inputUrl = (input: RequestInfo | URL | undefined): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : (input?.url ?? "");
};

const createHarness = (
  fetchImplementation: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof ResilientHttpClient>[1]> = {},
) => {
  const logs: string[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: (_message, fields) => logs.push(JSON.stringify(fields)),
    warn: (_message, fields) => logs.push(JSON.stringify(fields)),
    error: vi.fn(),
  };
  const getAccessToken = vi.fn(() => Promise.resolve("access-token"));
  const tokenProvider: AccessTokenProvider = { getAccessToken };
  const sleeps: number[] = [];
  const client = new ResilientHttpClient(tokenProvider, {
    baseUrls: { fabric: "https://fabric.test", powerbi: "https://powerbi.test" },
    timeoutMs: 25,
    maxRetries: 2,
    maxResponseBytes: 1_024,
    logger,
    fetch: fetchImplementation,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
    random: () => 0,
    now: () => Date.parse("2026-09-02T12:00:00Z"),
    ...overrides,
  });
  return { client, getAccessToken, logs, sleeps };
};

describe("ResilientHttpClient", () => {
  it("sends scoped authorization, JSON, query values, and preserves response metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        200,
        { value: "ok" },
        {
          "x-ms-request-id": "request-1",
          "x-ms-operation-id": "operation-1",
          location: "https://fabric.test/v1/operations/operation-1",
          "retry-after": "2",
        },
      ),
    );
    const { client, getAccessToken, logs } = createHarness(fetchMock);

    const result = await client.request({
      service: "fabric",
      operation: "test_request",
      method: "POST",
      path: "/v1/items",
      query: { enabled: true, page: 2, omitted: undefined },
      body: { name: "model" },
      responseSchema: z.object({ value: z.literal("ok") }),
    });

    expect(result).toEqual({
      status: 200,
      data: { value: "ok" },
      requestId: "request-1",
      operationId: "operation-1",
      location: "https://fabric.test/v1/operations/operation-1",
      retryAfterMs: 2_000,
    });
    expect(getAccessToken).toHaveBeenCalledWith("fabric");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(inputUrl(url)).toBe("https://fabric.test/v1/items?enabled=true&page=2");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ name: "model" }));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
    expect(logs.join(" ")).toContain("request-1");
    expect(logs.join(" ")).not.toContain("access-token");
  });

  it("retries safe calls on 429 and 5xx while honoring Retry-After", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(429, { errorCode: "TooManyRequests" }, { "retry-after": "3" }),
      )
      .mockResolvedValueOnce(response(503, { errorCode: "Unavailable" }))
      .mockResolvedValueOnce(response(200, { value: [] }));
    const { client, sleeps } = createHarness(fetchMock);

    await expect(
      client.request({
        service: "fabric",
        operation: "list_items",
        method: "GET",
        path: "/v1/items",
        responseSchema: z.object({ value: z.array(z.unknown()) }),
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([3_000, 250]);
  });

  it("parses HTTP-date Retry-After and caps excessive delays", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(429, {}, { "retry-after": "Wed, 02 Sep 2026 12:01:00 GMT" }))
      .mockResolvedValueOnce(response(200, {}));
    const { client, sleeps } = createHarness(fetchMock, { maxRetryDelayMs: 5_000 });

    await client.request({
      service: "fabric",
      operation: "date_retry",
      method: "GET",
      path: "/v1/items",
      responseSchema: z.object({}),
    });
    expect(sleeps).toEqual([5_000]);
  });

  it.each([
    [401, "AUTHENTICATION_FAILED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [500, "SERVICE_UNAVAILABLE"],
    [400, "API_REQUEST_FAILED"],
  ])("maps HTTP %i to %s with safe service details", async (status, code) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        status,
        {
          errorCode: "ServiceCode",
          message: "failure includes access-token",
          requestId: "body-request",
          isRetriable: status >= 500,
        },
        { "x-ms-correlation-id": "header-request", "retry-after": "invalid" },
      ),
    );
    const { client } = createHarness(fetchMock, { maxRetries: 0 });

    const error = await client
      .request({
        service: "fabric",
        operation: "mapped_error",
        method: "GET",
        path: "/v1/items",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code,
      httpStatus: status,
      requestId: "header-request",
      serviceCode: "ServiceCode",
    });
    expect(String(error)).not.toContain("access-token");
    expect((error as ApiError).toJSON()).not.toHaveProperty("cause");
  });

  it("maps nested Power BI errors and body request IDs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(403, { error: { code: "PowerBiDenied", message: "Denied" } }));
    const { client } = createHarness(fetchMock, { maxRetries: 0 });

    await expect(
      client.request({
        service: "powerbi",
        operation: "execute",
        method: "POST",
        path: "/v1/query",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", serviceCode: "PowerBiDenied" });
  });

  it("never retries unsafe operations", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(503, {}));
    const { client, sleeps } = createHarness(fetchMock);

    await expect(
      client.request({
        service: "fabric",
        operation: "create_item",
        method: "POST",
        path: "/v1/items",
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
  });

  it("retries safe network errors but returns typed terminal network failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket secret"));
    const { client } = createHarness(fetchMock, { maxRetries: 1 });

    const failure = await client
      .request({
        service: "fabric",
        operation: "network",
        method: "GET",
        path: "/v1/items",
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(String(failure)).not.toContain("socket secret");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts timed-out calls and returns a typed timeout", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const { client } = createHarness(fetchMock, { timeoutMs: 5, maxRetries: 0 });

    await expect(
      client.request({
        service: "fabric",
        operation: "timeout",
        method: "GET",
        path: "/v1/items",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", retryable: true });
  });

  it("rejects malformed, empty, schema-invalid, and oversized responses", async () => {
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("not-json", { status: 200, headers: jsonHeaders }));
    await expect(
      createHarness(malformed).client.request({
        service: "fabric",
        operation: "malformed",
        method: "GET",
        path: "/v1/items",
        responseSchema: z.object({ value: z.string() }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });

    const empty = vi.fn<typeof fetch>().mockResolvedValue(new Response(undefined, { status: 200 }));
    await expect(
      createHarness(empty).client.request({
        service: "fabric",
        operation: "empty",
        method: "GET",
        path: "/v1/items",
        responseSchema: z.object({}),
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });

    const invalid = vi.fn<typeof fetch>().mockResolvedValue(response(200, { value: 42 }));
    await expect(
      createHarness(invalid).client.request({
        service: "fabric",
        operation: "invalid",
        method: "GET",
        path: "/v1/items",
        responseSchema: z.object({ value: z.string() }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });

    const oversized = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(100), { status: 200 }));
    await expect(
      createHarness(oversized, { maxResponseBytes: 20 }).client.request({
        service: "fabric",
        operation: "oversized",
        method: "GET",
        path: "/v1/items",
        responseSchema: z.string(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it("allows explicitly empty responses and blocks paths that can change origin", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }))
      .mockResolvedValueOnce(response(202, null));
    const { client } = createHarness(fetchMock);
    await expect(
      client.request({
        service: "fabric",
        operation: "empty_ok",
        method: "DELETE",
        path: "/v1/items/id",
        allowEmptyResponse: true,
      }),
    ).resolves.toMatchObject({ status: 204, data: undefined });
    await expect(
      client.request({
        service: "fabric",
        operation: "null_empty_ok",
        method: "POST",
        path: "/v1/items",
        responseSchema: z.object({ id: z.string() }),
        expectedStatuses: [202],
        allowEmptyResponse: true,
      }),
    ).resolves.toMatchObject({ status: 202, data: undefined });
    await expect(
      client.request({
        service: "fabric",
        operation: "bad_path",
        method: "GET",
        path: "v1/items",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST_PATH" });
    await expect(
      client.request({
        service: "fabric",
        operation: "bad_origin",
        method: "GET",
        path: "//evil.test/items",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST_PATH" });
  });
});
