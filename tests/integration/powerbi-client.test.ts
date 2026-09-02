import { describe, expect, it, vi } from "vitest";
import { ResilientHttpClient } from "../../src/clients/http-client.js";
import { PowerBiClient } from "../../src/clients/powerbi-client.js";
import type { AccessTokenProvider } from "../../src/identity.js";
import type { Logger } from "../../src/logging.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MODEL_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REFRESH_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const jsonResponse = (
  status: number,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response =>
  new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const inputUrl = (input: RequestInfo | URL | undefined): string => {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : (input?.url ?? "");
};

const requestBody = (init: RequestInit | undefined): string =>
  typeof init?.body === "string" ? init.body : "";

const createPowerBiClient = (
  fetchImplementation: typeof fetch,
  options: { allowed?: readonly string[]; readOnly?: boolean } = {},
): PowerBiClient => {
  const tokenProvider: AccessTokenProvider = {
    getAccessToken: () => Promise.resolve("powerbi-token"),
  };
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return new PowerBiClient(
    new ResilientHttpClient(tokenProvider, {
      baseUrls: { fabric: "https://fabric.test", powerbi: "https://powerbi.test" },
      timeoutMs: 100,
      maxRetries: 0,
      maxResponseBytes: 100_000,
      logger,
      fetch: fetchImplementation,
    }),
    {
      allowedWorkspaceIds: options.allowed ?? [WORKSPACE_ID],
      readOnly: options.readOnly ?? true,
    },
  );
};

describe("PowerBiClient", () => {
  it("executes a DAX query through the JSON executeQueries contract", async () => {
    const payload = {
      results: [{ tables: [{ rows: [{ "[Total Sales]": 123.45, "[Blank]": null }] }] }],
    };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(200, payload));
    const client = createPowerBiClient(fetchMock);

    await expect(
      client.executeDax(WORKSPACE_ID, MODEL_ID, {
        query: 'EVALUATE ROW("Total Sales", [Total Sales])',
        includeNulls: true,
      }),
    ).resolves.toEqual(payload);
    expect(inputUrl(fetchMock.mock.calls[0]?.[0])).toContain(
      `/groups/${WORKSPACE_ID}/datasets/${MODEL_ID}/executeQueries`,
    );
    expect(JSON.parse(requestBody(fetchMock.mock.calls[0]?.[1])) as unknown).toEqual({
      queries: [{ query: 'EVALUATE ROW("Total Sales", [Total Sales])' }],
      serializerSettings: { includeNulls: true },
    });
  });

  it("starts an enhanced refresh without the unsupported service-principal notifyOption", async () => {
    const location = `https://powerbi.test/v1.0/myorg/groups/${WORKSPACE_ID}/datasets/${MODEL_ID}/refreshes/${REFRESH_ID}`;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(202, undefined, {
        "x-ms-request-id": REFRESH_ID,
        location,
        "retry-after": "4",
      }),
    );
    const client = createPowerBiClient(fetchMock, { readOnly: false });

    await expect(
      client.startRefresh(WORKSPACE_ID, MODEL_ID, {
        objects: [{ table: "Sales", partition: "Sales-2026" }],
        maxParallelism: 4,
      }),
    ).resolves.toEqual({ requestId: REFRESH_ID, location, retryAfterMs: 4_000 });
    const parsedRequestBody: unknown = JSON.parse(requestBody(fetchMock.mock.calls[0]?.[1]));
    expect(parsedRequestBody).toEqual({
      type: "full",
      commitMode: "transactional",
      objects: [{ table: "Sales", partition: "Sales-2026" }],
      maxParallelism: 4,
    });
    expect(parsedRequestBody).not.toHaveProperty("notifyOption");
  });

  it("gets bounded refresh history and execution details for completed and running refreshes", async () => {
    const history = {
      value: [{ requestId: REFRESH_ID, refreshType: "ViaApi", status: "Completed" }],
    };
    const completed = {
      requestId: REFRESH_ID,
      status: "Completed",
      type: "Full",
      commitMode: "Transactional",
      numberOfAttempts: 1,
      messages: [],
    };
    const running = { ...completed, status: "Unknown", extendedStatus: "NotStarted" };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, history))
      .mockResolvedValueOnce(jsonResponse(200, completed))
      .mockResolvedValueOnce(jsonResponse(202, running));
    const client = createPowerBiClient(fetchMock);

    await expect(client.getRefreshHistory(WORKSPACE_ID, MODEL_ID, 5)).resolves.toEqual(
      history.value,
    );
    await expect(
      client.getRefreshExecutionDetails(WORKSPACE_ID, MODEL_ID, REFRESH_ID),
    ).resolves.toMatchObject({ status: 200, data: completed });
    await expect(
      client.getRefreshExecutionDetails(WORKSPACE_ID, MODEL_ID, REFRESH_ID),
    ).resolves.toMatchObject({ status: 202, data: running });
    expect(inputUrl(fetchMock.mock.calls[0]?.[0])).toContain("%24top=5");
  });

  it("blocks refresh mutation in read-only mode before making an HTTP call", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createPowerBiClient(fetchMock);

    await expect(client.startRefresh(WORKSPACE_ID, MODEL_ID, {})).rejects.toMatchObject({
      code: "READ_ONLY_VIOLATION",
      service: "powerbi",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates workspace, model, refresh, DAX, refresh, and history inputs", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const writableClient = createPowerBiClient(fetchMock, { readOnly: false });

    await expect(
      writableClient.executeDax(OTHER_WORKSPACE_ID, MODEL_ID, { query: "EVALUATE ROW()" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_ALLOWED" });
    await expect(
      writableClient.executeDax("bad", MODEL_ID, { query: "EVALUATE ROW()" }),
    ).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
    await expect(
      writableClient.executeDax(WORKSPACE_ID, "bad", { query: "EVALUATE ROW()" }),
    ).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
    await expect(
      writableClient.executeDax(WORKSPACE_ID, MODEL_ID, { query: " " }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      writableClient.startRefresh(WORKSPACE_ID, MODEL_ID, { retryCount: 11 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(writableClient.getRefreshHistory(WORKSPACE_ID, MODEL_ID, 0)).rejects.toMatchObject(
      {
        code: "INVALID_REQUEST",
      },
    );
    await expect(
      writableClient.getRefreshExecutionDetails(WORKSPACE_ID, MODEL_ID, "bad"),
    ).rejects.toMatchObject({ code: "INVALID_IDENTIFIER" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects missing query data and incomplete refresh tracking headers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200))
      .mockResolvedValueOnce(jsonResponse(202, undefined, { "x-ms-request-id": REFRESH_ID }));
    const client = createPowerBiClient(fetchMock, { readOnly: false });

    await expect(
      client.executeDax(WORKSPACE_ID, MODEL_ID, { query: "EVALUATE ROW()" }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    await expect(client.startRefresh(WORKSPACE_ID, MODEL_ID, {})).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });
});
