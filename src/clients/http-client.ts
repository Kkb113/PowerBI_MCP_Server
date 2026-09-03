import { z } from "zod";
import type { Logger } from "../logging.js";
import { redact } from "../logging.js";
import type { AccessTokenProvider, TokenAudience } from "../identity.js";
import { ApiError, type ExternalService } from "./errors.js";

type HttpService = Exclude<TokenAudience, "fabric-sql">;

export type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type RetryMode = "never" | "safe";

export interface HttpClientOptions {
  readonly baseUrls: Readonly<Record<HttpService, string>>;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly maxResponseBytes: number;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly maxRetryDelayMs?: number;
}

export interface ApiRequest<T> {
  readonly service: HttpService;
  readonly operation: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, boolean | number | string | undefined>>;
  readonly body?: unknown;
  readonly responseSchema?: z.ZodType<T>;
  readonly expectedStatuses?: readonly number[];
  readonly allowEmptyResponse?: boolean;
  readonly retryMode?: RetryMode;
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly data: T | undefined;
  readonly requestId: string | undefined;
  readonly operationId: string | undefined;
  readonly location: string | undefined;
  readonly retryAfterMs: number | undefined;
}

const fabricErrorSchema = z.object({
  errorCode: z.string().optional(),
  message: z.string().optional(),
  isRetriable: z.boolean().optional(),
  requestId: z.string().optional(),
});

const powerBiErrorSchema = z.object({
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
});

const defaultSleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

const statusErrorCode = (status: number): string => {
  switch (status) {
    case 401:
      return "AUTHENTICATION_FAILED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "SERVICE_UNAVAILABLE" : "API_REQUEST_FAILED";
  }
};

const serviceName = (service: TokenAudience): ExternalService => service;

export class ResilientHttpClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly maxRetryDelayMs: number;

  public constructor(
    private readonly tokenProvider: AccessTokenProvider,
    private readonly options: HttpClientOptions,
  ) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
  }

  public async request<T>(request: ApiRequest<T>): Promise<ApiResponse<T>> {
    const url = this.buildUrl(request);
    const retryMode = request.retryMode ?? (request.method === "GET" ? "safe" : "never");
    const expectedStatuses = request.expectedStatuses ?? [];
    const startedAt = this.now();

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const token = await this.tokenProvider.getAccessToken(request.service);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);

      try {
        const response = await this.fetchImplementation(url, {
          method: request.method,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(request.body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: controller.signal,
        });

        const retryAfterMs = this.parseRetryAfter(response.headers.get("retry-after"));
        const retryableStatus = response.status === 429 || response.status >= 500;
        if (retryMode === "safe" && retryableStatus && attempt < this.options.maxRetries) {
          await response.body?.cancel();
          const delayMs = retryAfterMs ?? this.backoffDelay(attempt);
          this.logRetry(request, response.status, attempt + 1, delayMs);
          await this.sleep(delayMs);
          continue;
        }

        const statusAccepted =
          expectedStatuses.length > 0
            ? expectedStatuses.includes(response.status)
            : response.status >= 200 && response.status < 300;

        if (!statusAccepted) {
          throw await this.createResponseError(request, response, token, retryAfterMs, retryMode);
        }

        const data = await this.parseSuccessBody(request, response);
        const metadata = this.responseMetadata(response, retryAfterMs);
        this.options.logger.info("External API request completed", {
          service: request.service,
          operation: request.operation,
          method: request.method,
          path: url.pathname,
          status: response.status,
          requestId: metadata.requestId,
          attempt: attempt + 1,
          durationMs: this.now() - startedAt,
        });

        return { status: response.status, data, ...metadata };
      } catch (error: unknown) {
        if (error instanceof ApiError) {
          throw error;
        }

        const timedOut = controller.signal.aborted;
        if (retryMode === "safe" && attempt < this.options.maxRetries) {
          const delayMs = this.backoffDelay(attempt);
          this.logRetry(request, timedOut ? "timeout" : "network", attempt + 1, delayMs);
          await this.sleep(delayMs);
          continue;
        }

        throw new ApiError(
          timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
          timedOut
            ? `The ${request.service} request timed out.`
            : `The ${request.service} request could not be completed.`,
          {
            service: serviceName(request.service),
            operation: request.operation,
            retryable: retryMode === "safe",
            cause: error,
          },
        );
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new ApiError("INTERNAL_ERROR", "The retry loop exited unexpectedly.", {
      service: serviceName(request.service),
      operation: request.operation,
    });
  }

  private buildUrl(request: ApiRequest<unknown>): URL {
    if (!request.path.startsWith("/")) {
      throw new ApiError("INVALID_REQUEST_PATH", "External API paths must start with a slash.", {
        service: serviceName(request.service),
        operation: request.operation,
      });
    }

    const baseUrl = new URL(this.options.baseUrls[request.service]);
    const url = new URL(request.path, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new ApiError(
        "INVALID_REQUEST_PATH",
        "External API path changed the configured origin.",
        {
          service: serviceName(request.service),
          operation: request.operation,
        },
      );
    }

    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    return url;
  }

  private async parseSuccessBody<T>(
    request: ApiRequest<T>,
    response: Response,
  ): Promise<T | undefined> {
    const bytes = await this.readBoundedBody(response, request);
    if (bytes.byteLength === 0) {
      if (request.responseSchema && !request.allowEmptyResponse) {
        throw this.invalidResponse(request, response, "The response body was empty.");
      }
      return undefined;
    }

    if (!request.responseSchema) {
      return undefined;
    }

    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error: unknown) {
      throw this.invalidResponse(request, response, "The response was not valid JSON.", error);
    }

    if (value === null && request.allowEmptyResponse) {
      return undefined;
    }

    const parsed = request.responseSchema.safeParse(value);
    if (!parsed.success) {
      throw this.invalidResponse(
        request,
        response,
        "The response did not match the expected schema.",
        parsed.error,
      );
    }
    return parsed.data;
  }

  private async readBoundedBody(
    response: Response,
    request: ApiRequest<unknown>,
  ): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.options.maxResponseBytes) {
      await response.body?.cancel();
      throw this.invalidResponse(
        request,
        response,
        "The response exceeded the configured size limit.",
      );
    }

    if (!response.body) {
      return new Uint8Array();
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      byteLength += result.value.byteLength;
      if (byteLength > this.options.maxResponseBytes) {
        await reader.cancel();
        throw this.invalidResponse(
          request,
          response,
          "The response exceeded the configured size limit.",
        );
      }
      chunks.push(result.value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  private invalidResponse(
    request: ApiRequest<unknown>,
    response: Response,
    message: string,
    cause?: unknown,
  ): ApiError {
    const requestId = this.extractRequestId(response.headers);
    return new ApiError("INVALID_API_RESPONSE", message, {
      service: serviceName(request.service),
      operation: request.operation,
      httpStatus: response.status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  private async createResponseError(
    request: ApiRequest<unknown>,
    response: Response,
    accessToken: string,
    retryAfterMs: number | undefined,
    retryMode: RetryMode,
  ): Promise<ApiError> {
    const bytes = await this.readBoundedBody(response, request);
    const genericMessage = `${request.service} returned HTTP ${response.status}.`;
    let message = genericMessage;
    let serviceCode: string | undefined;
    let bodyRequestId: string | undefined;
    let serviceRetryable: boolean | undefined;

    if (bytes.byteLength > 0) {
      try {
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const fabricError =
          request.service === "fabric" ? fabricErrorSchema.safeParse(value) : undefined;
        const powerBiError =
          request.service === "powerbi" ? powerBiErrorSchema.safeParse(value) : undefined;
        if (fabricError?.success) {
          message = fabricError.data.message ?? genericMessage;
          serviceCode = fabricError.data.errorCode;
          bodyRequestId = fabricError.data.requestId;
          serviceRetryable = fabricError.data.isRetriable;
        } else if (powerBiError?.success && powerBiError.data.error) {
          message = powerBiError.data.error.message ?? genericMessage;
          serviceCode = powerBiError.data.error.code;
        }
      } catch {
        message = genericMessage;
      }
    }

    const safeMessage = redact(message, [accessToken]);
    const retryable =
      retryMode === "safe" &&
      (serviceRetryable ?? (response.status === 429 || response.status >= 500));

    const requestId = this.extractRequestId(response.headers) ?? bodyRequestId;
    return new ApiError(statusErrorCode(response.status), String(safeMessage), {
      service: serviceName(request.service),
      operation: request.operation,
      httpStatus: response.status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(serviceCode === undefined ? {} : { serviceCode }),
      retryable,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }

  private responseMetadata(
    response: Response,
    retryAfterMs: number | undefined,
  ): Omit<ApiResponse<unknown>, "data" | "status"> {
    return {
      requestId: this.extractRequestId(response.headers),
      operationId: response.headers.get("x-ms-operation-id") ?? undefined,
      location: response.headers.get("location") ?? undefined,
      retryAfterMs,
    };
  }

  private extractRequestId(headers: Headers): string | undefined {
    return (
      headers.get("x-ms-request-id") ??
      headers.get("request-id") ??
      headers.get("x-ms-correlation-id") ??
      undefined
    );
  }

  private parseRetryAfter(value: string | null): number | undefined {
    if (!value) {
      return undefined;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.ceil(seconds * 1_000), this.maxRetryDelayMs);
    }

    const date = Date.parse(value);
    if (Number.isNaN(date)) {
      return undefined;
    }
    return Math.min(Math.max(0, date - this.now()), this.maxRetryDelayMs);
  }

  private backoffDelay(attempt: number): number {
    const exponential = 250 * 2 ** attempt;
    const jittered = exponential * (0.5 + this.random() * 0.5);
    return Math.min(Math.ceil(jittered), this.maxRetryDelayMs);
  }

  private logRetry(
    request: ApiRequest<unknown>,
    reason: number | "network" | "timeout",
    nextAttempt: number,
    delayMs: number,
  ): void {
    this.options.logger.warn("Retrying safe external API request", {
      service: request.service,
      operation: request.operation,
      method: request.method,
      reason,
      nextAttempt: nextAttempt + 1,
      delayMs,
    });
  }
}
