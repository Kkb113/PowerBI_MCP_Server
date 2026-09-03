import { z } from "zod";
import { ConfigurationError } from "../src/config.js";

export function requireLiveTestWorkspaceId(environment: NodeJS.ProcessEnv = process.env): string {
  const parsed = z.uuid().safeParse(environment["FABRIC_TEST_WORKSPACE_ID"]?.trim());
  if (!parsed.success) {
    throw new ConfigurationError([
      "FABRIC_TEST_WORKSPACE_ID must contain exactly one disposable non-production workspace UUID for mutation testing.",
    ]);
  }
  return parsed.data;
}
