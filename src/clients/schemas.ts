import { z } from "zod";
import { jsonValueSchema } from "../mcp/schemas.js";

export const workspaceSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  description: z.string().optional(),
  type: z.string(),
  capacityId: z.uuid().optional(),
  capacityRegion: z.string().optional(),
  domainId: z.uuid().optional(),
  apiEndpoint: z.url().optional(),
});

export const workspacePageSchema = z.object({
  value: z.array(workspaceSchema),
  continuationToken: z.string().optional(),
  continuationUri: z.url().optional(),
});

export const semanticModelSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  description: z.string().optional(),
  type: z.literal("SemanticModel"),
  workspaceId: z.uuid(),
  folderId: z.uuid().optional(),
  sensitivityLabel: z.object({ id: z.uuid() }).optional(),
});

export const semanticModelPageSchema = z.object({
  value: z.array(semanticModelSchema),
  continuationToken: z.string().optional(),
  continuationUri: z.url().optional(),
});

export const definitionPartSchema = z.object({
  path: z.string().min(1),
  payload: z.string(),
  payloadType: z.literal("InlineBase64"),
});

export const semanticModelDefinitionSchema = z.object({
  format: z.enum(["TMDL", "TMSL"]).optional(),
  parts: z.array(definitionPartSchema).min(1),
});

export const semanticModelDefinitionResponseSchema = z.object({
  definition: semanticModelDefinitionSchema,
});

export const operationStateSchema = z.object({
  status: z.string().min(1),
  createdTimeUtc: z.iso.datetime({ offset: true }).optional(),
  lastUpdatedTimeUtc: z.iso.datetime({ offset: true }).optional(),
  percentComplete: z.number().int().min(0).max(100).optional(),
  error: z
    .object({
      errorCode: z.string().optional(),
      message: z.string().optional(),
      requestId: z.string().optional(),
      isRetriable: z.boolean().optional(),
    })
    .nullable()
    .optional(),
});

export const executeQueriesResponseSchema = z.object({
  results: z.array(
    z.object({
      tables: z
        .array(
          z.object({
            rows: z.array(z.record(z.string(), jsonValueSchema)).optional(),
          }),
        )
        .optional(),
      error: z
        .object({
          code: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const refreshAttemptSchema = z.object({
  attemptId: z.number().int().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  type: z.string().optional(),
  serviceExceptionJson: z.string().optional(),
});

export const refreshSchema = z.object({
  requestId: z.string().optional(),
  id: z.string().optional(),
  refreshType: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  status: z.string().optional(),
  serviceExceptionJson: z.string().optional(),
  refreshAttempts: z.array(refreshAttemptSchema).optional(),
});

export const refreshHistorySchema = z.object({
  value: z.array(refreshSchema),
});

export const refreshExecutionDetailsSchema = refreshSchema.extend({
  type: z.string().optional(),
  commitMode: z.string().optional(),
  extendedStatus: z.string().optional(),
  currentRefreshType: z.string().optional(),
  numberOfAttempts: z.number().int().optional(),
  initiatedBy: z.string().optional(),
  messages: z
    .array(
      z.object({
        message: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});

export type Workspace = z.infer<typeof workspaceSchema>;
export type SemanticModel = z.infer<typeof semanticModelSchema>;
export type SemanticModelDefinition = z.infer<typeof semanticModelDefinitionSchema>;
export type OperationState = z.infer<typeof operationStateSchema>;
export type ExecuteQueriesResponse = z.infer<typeof executeQueriesResponseSchema>;
export type Refresh = z.infer<typeof refreshSchema>;
export type RefreshExecutionDetails = z.infer<typeof refreshExecutionDetailsSchema>;
