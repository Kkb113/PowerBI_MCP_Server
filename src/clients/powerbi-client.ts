import { z } from "zod";
import { assertWritable, ApiError } from "./errors.js";
import type { ApiResponse } from "./http-client.js";
import type { ResilientHttpClient } from "./http-client.js";
import { validateUuid } from "./policy.js";
import {
  executeQueriesResponseSchema,
  refreshExecutionDetailsSchema,
  refreshHistorySchema,
  type ExecuteQueriesResponse,
  type Refresh,
  type RefreshExecutionDetails,
} from "./schemas.js";

export const POWERBI_API_BASE_URL = "https://api.powerbi.com";

export const executeDaxRequestSchema = z.object({
  query: z.string().trim().min(1).max(1_000_000),
  includeNulls: z.boolean().default(false),
});

const refreshObjectSchema = z.object({
  table: z.string().trim().min(1).max(256),
  partition: z.string().trim().min(1).max(256).optional(),
});

export const startRefreshRequestSchema = z.object({
  type: z
    .enum(["automatic", "full", "calculate", "clearValues", "dataOnly", "defragment"])
    .default("full"),
  commitMode: z.enum(["transactional", "partialBatch"]).default("transactional"),
  maxParallelism: z.number().int().min(1).max(160).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  objects: z.array(refreshObjectSchema).min(1).max(1_000).optional(),
  applyRefreshPolicy: z.boolean().optional(),
  effectiveDate: z.iso.datetime({ offset: true }).optional(),
});

export type ExecuteDaxRequest = z.input<typeof executeDaxRequestSchema>;
export type StartRefreshRequest = z.input<typeof startRefreshRequestSchema>;

export interface PowerBiClientOptions {
  readonly readOnly: boolean;
}

export interface StartedRefresh {
  readonly requestId: string;
  readonly location: string;
  readonly retryAfterMs: number | undefined;
}

const invalidInput = (operation: string, error: z.ZodError): ApiError =>
  new ApiError("INVALID_REQUEST", "The Power BI request did not match the expected schema.", {
    service: "powerbi",
    operation,
    cause: error,
  });

export class PowerBiClient {
  public constructor(
    private readonly http: ResilientHttpClient,
    private readonly options: PowerBiClientOptions,
  ) {}

  public async executeDax(
    workspaceId: string,
    semanticModelId: string,
    request: ExecuteDaxRequest,
  ): Promise<ExecuteQueriesResponse> {
    const operation = "execute_dax";
    const ids = this.datasetIds(workspaceId, semanticModelId, operation);
    const parsed = this.parseInput(executeDaxRequestSchema, request, operation);
    const response = await this.http.request({
      service: "powerbi",
      operation,
      method: "POST",
      path: `/v1.0/myorg/groups/${ids.workspaceId}/datasets/${ids.semanticModelId}/executeQueries`,
      body: {
        queries: [{ query: parsed.query }],
        serializerSettings: { includeNulls: parsed.includeNulls },
      },
      responseSchema: executeQueriesResponseSchema,
      expectedStatuses: [200],
      retryMode: "safe",
    });
    return this.requireData(response, operation);
  }

  public async startRefresh(
    workspaceId: string,
    semanticModelId: string,
    request: StartRefreshRequest,
  ): Promise<StartedRefresh> {
    const operation = "start_refresh";
    const ids = this.datasetIds(workspaceId, semanticModelId, operation);
    assertWritable(this.options.readOnly, operation, "powerbi");
    const body = this.parseInput(startRefreshRequestSchema, request, operation);
    const response = await this.http.request({
      service: "powerbi",
      operation,
      method: "POST",
      path: `/v1.0/myorg/groups/${ids.workspaceId}/datasets/${ids.semanticModelId}/refreshes`,
      body,
      expectedStatuses: [202],
      allowEmptyResponse: true,
      retryMode: "never",
    });

    if (!response.requestId || !response.location) {
      throw new ApiError(
        "INVALID_API_RESPONSE",
        "Power BI accepted the refresh without required tracking headers.",
        {
          service: "powerbi",
          operation,
          httpStatus: response.status,
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        },
      );
    }
    return {
      requestId: response.requestId,
      location: response.location,
      retryAfterMs: response.retryAfterMs,
    };
  }

  public async getRefreshHistory(
    workspaceId: string,
    semanticModelId: string,
    top = 20,
  ): Promise<readonly Refresh[]> {
    const operation = "get_refresh_history";
    const ids = this.datasetIds(workspaceId, semanticModelId, operation);
    if (!Number.isInteger(top) || top < 1 || top > 60) {
      throw new ApiError("INVALID_REQUEST", "top must be an integer between 1 and 60.", {
        service: "powerbi",
        operation,
      });
    }
    const response = await this.http.request({
      service: "powerbi",
      operation,
      method: "GET",
      path: `/v1.0/myorg/groups/${ids.workspaceId}/datasets/${ids.semanticModelId}/refreshes`,
      query: { $top: top },
      responseSchema: refreshHistorySchema,
      retryMode: "safe",
    });
    return this.requireData(response, operation).value;
  }

  public async getRefreshExecutionDetails(
    workspaceId: string,
    semanticModelId: string,
    refreshId: string,
  ): Promise<ApiResponse<RefreshExecutionDetails>> {
    const operation = "get_refresh_execution_details";
    const ids = this.datasetIds(workspaceId, semanticModelId, operation);
    const validRefreshId = validateUuid(refreshId, "refreshId", operation, "powerbi");
    return await this.http.request({
      service: "powerbi",
      operation,
      method: "GET",
      path: `/v1.0/myorg/groups/${ids.workspaceId}/datasets/${ids.semanticModelId}/refreshes/${validRefreshId}`,
      responseSchema: refreshExecutionDetailsSchema,
      expectedStatuses: [200, 202],
      retryMode: "safe",
    });
  }

  private datasetIds(
    workspaceId: string,
    semanticModelId: string,
    operation: string,
  ): { readonly workspaceId: string; readonly semanticModelId: string } {
    const validWorkspaceId = validateUuid(workspaceId, "workspaceId", operation, "powerbi");
    const validSemanticModelId = validateUuid(
      semanticModelId,
      "semanticModelId",
      operation,
      "powerbi",
    );
    return { workspaceId: validWorkspaceId, semanticModelId: validSemanticModelId };
  }

  private parseInput<T>(schema: z.ZodType<T>, input: unknown, operation: string): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw invalidInput(operation, parsed.error);
    }
    return parsed.data;
  }

  private requireData<T>(response: ApiResponse<T>, operation: string): T {
    if (response.data === undefined) {
      throw new ApiError("INVALID_API_RESPONSE", "Power BI returned an empty response body.", {
        service: "powerbi",
        operation,
        httpStatus: response.status,
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      });
    }
    return response.data;
  }
}
