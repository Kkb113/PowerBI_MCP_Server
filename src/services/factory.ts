import { createMicrosoftApiClients } from "../clients/factory.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logging.js";
import { McpWorkflowService } from "./mcp-workflow-service.js";
import { SemanticModelService } from "./semantic-model-service.js";
import { FabricDataService } from "./fabric-data-service.js";

export function createMcpWorkflowService(config: AppConfig, logger: Logger): McpWorkflowService {
  const clients = createMicrosoftApiClients(config, logger);
  const semanticModels = new SemanticModelService(clients.fabric, {
    lroPollBudgetMs: config.lroPollBudgetMs,
  });
  const fabricData = new FabricDataService(clients.fabric, clients.fabricSql);
  return new McpWorkflowService(semanticModels, clients.fabric, clients.powerBi, fabricData, {
    maxDaxRows: config.dax.maxRows,
    maxResponseBytes: config.dax.maxResponseBytes,
    maxDataResponseBytes: config.data.maxResponseBytes,
    readOnly: config.readOnly,
  });
}
