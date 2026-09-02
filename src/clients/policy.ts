import { z } from "zod";
import { ApiError, type ExternalService, workspaceNotAllowed } from "./errors.js";

const uuidSchema = z.uuid();

export function validateUuid(
  value: string,
  field: string,
  operation: string,
  service: ExternalService,
): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new ApiError("INVALID_IDENTIFIER", `${field} must be a valid UUID.`, {
      service,
      operation,
    });
  }
  return value;
}

export class WorkspacePolicy {
  private readonly allowedWorkspaceIds: ReadonlySet<string>;

  public constructor(workspaceIds: readonly string[]) {
    this.allowedWorkspaceIds = new Set(
      workspaceIds.map((workspaceId) => workspaceId.toLowerCase()),
    );
  }

  public get size(): number {
    return this.allowedWorkspaceIds.size;
  }

  public allows(workspaceId: string): boolean {
    return this.allowedWorkspaceIds.has(workspaceId.toLowerCase());
  }

  public assertAllowed(workspaceId: string, operation: string, service: ExternalService): string {
    const validId = validateUuid(workspaceId, "workspaceId", operation, service);
    if (!this.allows(validId)) {
      throw workspaceNotAllowed(validId, operation, service);
    }
    return validId;
  }
}
