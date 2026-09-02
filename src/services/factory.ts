import { createMicrosoftApiClients } from "../clients/factory.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { McpWorkflowService } from "./mcp-workflow-service.js";
import { SemanticModelService } from "./semantic-model-service.js";

export function createMcpWorkflowService(config: AppConfig, logger: Logger): McpWorkflowService {
  const clients = createMicrosoftApiClients(config, logger);
  const semanticModels = new SemanticModelService(clients.fabric, {
    lroPollBudgetMs: config.lroPollBudgetMs,
  });
  return new McpWorkflowService(semanticModels, clients.fabric, clients.powerBi, {
    maxDaxRows: config.dax.maxRows,
    maxResponseBytes: config.dax.maxResponseBytes,
    readOnly: config.readOnly,
  });
}
