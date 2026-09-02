import { z } from "zod";
import { assertWritable, ApiError } from "./errors.js";
import type { ApiResponse } from "./http-client.js";
import type { ResilientHttpClient } from "./http-client.js";
import { validateUuid, WorkspacePolicy } from "./policy.js";
import {
  connectionSchema,
  operationStateSchema,
  semanticModelDefinitionResponseSchema,
  semanticModelDefinitionSchema,
  semanticModelPageSchema,
  semanticModelSchema,
  workspacePageSchema,
  type OperationState,
  type Connection,
  type SemanticModel,
  type SemanticModelDefinition,
  type Workspace,
} from "./schemas.js";

export const FABRIC_API_BASE_URL = "https://api.fabric.microsoft.com";

const boundedDisplayNameSchema = z.string().trim().min(1).max(256);
const itemDescriptionSchema = z.string().max(256);

export const createSemanticModelRequestSchema = z.object({
  displayName: boundedDisplayNameSchema,
  description: itemDescriptionSchema.optional(),
  definition: semanticModelDefinitionSchema,
});

export const updateSemanticModelRequestSchema = z
  .object({
    displayName: boundedDisplayNameSchema.optional(),
    description: itemDescriptionSchema.optional(),
  })
  .refine((value) => value.displayName !== undefined || value.description !== undefined, {
    message: "At least one semantic model property must be supplied.",
  });

export const bindConnectionRequestSchema = z.object({
  connectionBinding: z.object({
    id: z.uuid(),
    connectivityType: z.string().trim().min(1),
    connectionDetails: z.object({
      type: z.string().trim().min(1),
      path: z.string().trim().min(1),
    }),
  }),
});

export type CreateSemanticModelRequest = z.input<typeof createSemanticModelRequestSchema>;
export type UpdateSemanticModelRequest = z.input<typeof updateSemanticModelRequestSchema>;
export type BindConnectionRequest = z.input<typeof bindConnectionRequestSchema>;

export interface FabricClientOptions {
  readonly allowedWorkspaceIds: readonly string[];
  readonly readOnly: boolean;
  readonly maxPages: number;
}

export interface CompletedOperation<T> {
  readonly kind: "completed";
  readonly data: T;
  readonly requestId: string | undefined;
}

export interface AcceptedOperation {
  readonly kind: "accepted";
  readonly operationId: string;
  readonly location: string;
  readonly requestId: string | undefined;
  readonly retryAfterMs: number | undefined;
}

export type FabricOperation<T> = AcceptedOperation | CompletedOperation<T>;

const invalidInput = (operation: string, error: z.ZodError): ApiError =>
  new ApiError("INVALID_REQUEST", "The Fabric request did not match the expected schema.", {
    service: "fabric",
    operation,
    cause: error,
  });

export class FabricClient {
  private readonly workspacePolicy: WorkspacePolicy;

  public constructor(
    private readonly http: ResilientHttpClient,
    private readonly options: FabricClientOptions,
  ) {
    this.workspacePolicy = new WorkspacePolicy(options.allowedWorkspaceIds);
  }

  public async listWorkspaces(): Promise<readonly Workspace[]> {
    const operation = "list_workspaces";
    if (this.workspacePolicy.size === 0) {
      return [];
    }

    const workspaces = new Map<string, Workspace>();
    let continuationToken: string | undefined;

    for (let page = 1; page <= this.options.maxPages; page += 1) {
      const response = await this.http.request({
        service: "fabric",
        operation,
        method: "GET",
        path: "/v1/workspaces",
        query: { continuationToken },
        responseSchema: workspacePageSchema,
        retryMode: "safe",
      });
      const body = this.requireData(response, operation);

      for (const workspace of body.value) {
        if (this.workspacePolicy.allows(workspace.id)) {
          workspaces.set(workspace.id.toLowerCase(), workspace);
        }
      }

      continuationToken = body.continuationToken;
      if (!continuationToken || workspaces.size === this.workspacePolicy.size) {
        return [...workspaces.values()];
      }
    }

    throw this.paginationLimit(operation);
  }

  public async listSemanticModels(workspaceId: string): Promise<readonly SemanticModel[]> {
    const operation = "list_semantic_models";
    const allowedWorkspaceId = this.workspacePolicy.assertAllowed(workspaceId, operation, "fabric");
    const semanticModels: SemanticModel[] = [];
    let continuationToken: string | undefined;

    for (let page = 1; page <= this.options.maxPages; page += 1) {
      const response = await this.http.request({
        service: "fabric",
        operation,
        method: "GET",
        path: `/v1/workspaces/${allowedWorkspaceId}/semanticModels`,
        query: { continuationToken },
        responseSchema: semanticModelPageSchema,
        retryMode: "safe",
      });
      const body = this.requireData(response, operation);
      semanticModels.push(...body.value);
      continuationToken = body.continuationToken;

      if (!continuationToken) {
        return semanticModels;
      }
    }

    throw this.paginationLimit(operation);
  }

  public async getSemanticModel(
    workspaceId: string,
    semanticModelId: string,
  ): Promise<SemanticModel> {
    const operation = "get_semantic_model";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "GET",
      path: ids.path,
      responseSchema: semanticModelSchema,
      retryMode: "safe",
    });
    return this.requireData(response, operation);
  }

  public async getConnection(connectionId: string): Promise<Connection> {
    const operation = "get_connection";
    const validConnectionId = validateUuid(connectionId, "connectionId", operation, "fabric");
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "GET",
      path: `/v1/connections/${validConnectionId}`,
      responseSchema: connectionSchema,
      retryMode: "safe",
    });
    return this.requireData(response, operation);
  }

  public async createSemanticModel(
    workspaceId: string,
    request: CreateSemanticModelRequest,
  ): Promise<FabricOperation<SemanticModel>> {
    const operation = "create_semantic_model";
    const allowedWorkspaceId = this.workspacePolicy.assertAllowed(workspaceId, operation, "fabric");
    assertWritable(this.options.readOnly, operation);
    const body = this.parseInput(createSemanticModelRequestSchema, request, operation);
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "POST",
      path: `/v1/workspaces/${allowedWorkspaceId}/semanticModels`,
      body,
      responseSchema: semanticModelSchema,
      expectedStatuses: [201, 202],
      allowEmptyResponse: true,
      retryMode: "never",
    });
    return response.status === 202
      ? this.toAcceptedOperation(response, operation)
      : {
          kind: "completed",
          data: this.requireData(response, operation),
          requestId: response.requestId,
        };
  }

  public async updateSemanticModel(
    workspaceId: string,
    semanticModelId: string,
    request: UpdateSemanticModelRequest,
  ): Promise<ApiResponse<undefined>> {
    const operation = "update_semantic_model";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    assertWritable(this.options.readOnly, operation);
    const body = this.parseInput(updateSemanticModelRequestSchema, request, operation);
    return await this.http.request({
      service: "fabric",
      operation,
      method: "PATCH",
      path: ids.path,
      body,
      expectedStatuses: [200],
      allowEmptyResponse: true,
      retryMode: "never",
    });
  }

  public async permanentlyDeleteSemanticModel(
    workspaceId: string,
    semanticModelId: string,
  ): Promise<ApiResponse<undefined>> {
    const operation = "delete_semantic_model";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    assertWritable(this.options.readOnly, operation);
    return await this.http.request({
      service: "fabric",
      operation,
      method: "DELETE",
      path: ids.path,
      query: { hardDelete: true },
      expectedStatuses: [200],
      allowEmptyResponse: true,
      retryMode: "never",
    });
  }

  public async getSemanticModelDefinition(
    workspaceId: string,
    semanticModelId: string,
  ): Promise<FabricOperation<SemanticModelDefinition>> {
    const operation = "get_semantic_model_definition";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "POST",
      path: `${ids.path}/getDefinition`,
      query: { format: "TMSL" },
      responseSchema: semanticModelDefinitionResponseSchema,
      expectedStatuses: [200, 202],
      allowEmptyResponse: true,
      retryMode: "safe",
    });
    if (response.status === 202) {
      return this.toAcceptedOperation(response, operation);
    }
    return {
      kind: "completed",
      data: this.requireData(response, operation).definition,
      requestId: response.requestId,
    };
  }

  public async updateSemanticModelDefinition(
    workspaceId: string,
    semanticModelId: string,
    definition: SemanticModelDefinition,
    updateMetadata = true,
  ): Promise<FabricOperation<undefined>> {
    const operation = "update_semantic_model_definition";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    assertWritable(this.options.readOnly, operation);
    const parsedDefinition = this.parseInput(semanticModelDefinitionSchema, definition, operation);
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "POST",
      path: `${ids.path}/updateDefinition`,
      query: { updateMetadata },
      body: { definition: parsedDefinition },
      expectedStatuses: [200, 202],
      allowEmptyResponse: true,
      retryMode: "never",
    });
    return response.status === 202
      ? this.toAcceptedOperation(response, operation)
      : { kind: "completed", data: undefined, requestId: response.requestId };
  }

  public async bindSemanticModelConnection(
    workspaceId: string,
    semanticModelId: string,
    request: BindConnectionRequest,
  ): Promise<ApiResponse<undefined>> {
    const operation = "bind_semantic_model_connection";
    const ids = this.semanticModelPath(workspaceId, semanticModelId, operation);
    assertWritable(this.options.readOnly, operation);
    const body = this.parseInput(bindConnectionRequestSchema, request, operation);
    return await this.http.request({
      service: "fabric",
      operation,
      method: "POST",
      path: `${ids.path}/bindConnection`,
      body,
      expectedStatuses: [200],
      allowEmptyResponse: true,
      retryMode: "never",
    });
  }

  public async getOperationState(operationId: string): Promise<OperationState> {
    const operation = "get_operation_state";
    const validOperationId = validateUuid(operationId, "operationId", operation, "fabric");
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "GET",
      path: `/v1/operations/${validOperationId}`,
      responseSchema: operationStateSchema,
      retryMode: "safe",
    });
    return this.requireData(response, operation);
  }

  public async getOperationResult<T>(
    operationId: string,
    responseSchema: z.ZodType<T>,
  ): Promise<T> {
    const operation = "get_operation_result";
    const validOperationId = validateUuid(operationId, "operationId", operation, "fabric");
    const response = await this.http.request({
      service: "fabric",
      operation,
      method: "GET",
      path: `/v1/operations/${validOperationId}/result`,
      responseSchema,
      retryMode: "safe",
    });
    return this.requireData(response, operation);
  }

  private semanticModelPath(
    workspaceId: string,
    semanticModelId: string,
    operation: string,
  ): { readonly path: string } {
    const allowedWorkspaceId = this.workspacePolicy.assertAllowed(workspaceId, operation, "fabric");
    const validSemanticModelId = validateUuid(
      semanticModelId,
      "semanticModelId",
      operation,
      "fabric",
    );
    return { path: `/v1/workspaces/${allowedWorkspaceId}/semanticModels/${validSemanticModelId}` };
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
      throw new ApiError("INVALID_API_RESPONSE", "Fabric returned an empty response body.", {
        service: "fabric",
        operation,
        httpStatus: response.status,
        ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
      });
    }
    return response.data;
  }

  private toAcceptedOperation(
    response: ApiResponse<unknown>,
    operation: string,
  ): AcceptedOperation {
    if (!response.operationId || !response.location) {
      throw new ApiError(
        "INVALID_API_RESPONSE",
        "Fabric accepted the operation without required operation headers.",
        {
          service: "fabric",
          operation,
          httpStatus: response.status,
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
        },
      );
    }
    return {
      kind: "accepted",
      operationId: response.operationId,
      location: response.location,
      requestId: response.requestId,
      retryAfterMs: response.retryAfterMs,
    };
  }

  private paginationLimit(operation: string): ApiError {
    return new ApiError(
      "PAGINATION_LIMIT_EXCEEDED",
      "Fabric pagination exceeded the configured page limit.",
      { service: "fabric", operation },
    );
  }
}
