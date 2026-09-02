# TypeScript Fabric Semantic Model MCP Server — Six-Phase Implementation Plan

> Status: Phase 1 implemented on 2026-09-02. Phases 2-6 remain planned and are not implemented.
>
> Research date: 2026-09-02

## 1. Goal

Build a small, production-minded TypeScript MCP server that can manage the complete lifecycle of a Microsoft Fabric semantic model:

- Discover Fabric workspaces and semantic models.
- Create, read, update, and soft-delete semantic model items.
- Create, update, and delete model metadata such as tables, columns, partitions, measures, relationships, hierarchies, calculation groups, expressions, and roles.
- Author DAX expressions in measures and calculated objects.
- Execute DAX queries against a deployed semantic model.
- Bind model data-source references to Fabric connections.
- Trigger and inspect model refreshes.
- Validate changes, show diffs, enforce safety rules, and run post-deployment smoke tests.
- Run as a remote MCP server on Render for initial testing and later as the same container on Azure.

The Python repository in [`powerbi-mcp`](./powerbi-mcp/) is the behavioral reference for MCP contracts, DAX safety, model analysis, error handling, secret redaction, and destructive-operation controls. It is not a turnkey Fabric deployment implementation: its current cloud connector lists and queries existing datasets, while its offline authoring surface only creates selected TMDL objects. The TypeScript project therefore needs both a focused port and new Fabric lifecycle functionality.

## 2. Definition of “end to end”

The six phases are complete only when a clean test workspace can pass this lifecycle without manual model editing:

1. Authenticate to Fabric.
2. Create a semantic model from a typed model specification.
3. Read the item and its complete definition back.
4. Add, modify, and remove representative model objects.
5. Bind the model to a test connection when its storage mode requires one.
6. Refresh or reframe the model and wait for a terminal result.
7. Execute a DAX smoke query and return bounded structured results.
8. Update item properties and verify the change.
9. Produce a model summary, definition hash, and semantic diff.
10. Soft-delete the test model and verify that it is no longer listed.

“CRUD” refers to the semantic model item and its metadata. It does not mean inserting, updating, or deleting business-data rows. Row-level data mutations belong to the underlying Warehouse, Lakehouse, SQL database, or other data source.

## 3. Deliberately limited first scope

### Included

- Fabric cloud semantic models only.
- A remote, stateless MCP endpoint using Streamable HTTP.
- Service-principal authentication for local development and Render.
- Managed-identity authentication when moved to Azure.
- One tenant per running server instance.
- One canonical model representation for the first release.
- Import, DirectQuery, or Direct Lake definitions where the selected test source supports them.
- The subset of analysis and safety behavior required to make model changes dependable.

### Deferred

- Power BI Desktop discovery, ADOMD, TOM, Desktop Bridge, and named-pipe functionality.
- PBIP/PBIR report-page or visual authoring.
- PBIX extraction.
- XMLA and a .NET sidecar.
- Tenant-wide admin Scanner and Activity Events features.
- Multi-tenant SaaS account isolation.
- A database, Redis, message queue, job worker, or plugin architecture.
- Durable server-side storage of model definitions or audit files.
- A complete port of all 82 reference tools before the Fabric lifecycle works.

These items can be added later without changing the core Fabric client or model-mutation engine. Local Desktop features are also not usable from a Render-hosted Linux service, so including them in the initial build would not advance the stated goal.

## 4. Key technical decisions

### 4.1 One TypeScript service and one container

Use a single strict-TypeScript Node.js package, a single MCP process, and a single Docker image. The process exposes:

- `POST /mcp` for MCP Streamable HTTP traffic.
- `GET /health` for liveness.
- `GET /ready` for configuration readiness without making a Fabric request on every probe.

The service binds to `0.0.0.0:$PORT`. It remains stateless so Render restarts and its ephemeral filesystem do not affect model state.

### 4.2 TMSL JSON is the first canonical model format

Fabric semantic model definitions officially support either TMDL or TMSL. For the first release, use the TMSL `model.bim` JSON representation plus the required `definition.pbism` file.

This is a deliberate simplicity choice:

- JSON can be parsed and validated reliably in TypeScript.
- Object-level CRUD can operate on a typed in-memory tree.
- Deterministic serialization, hashing, and semantic diffs are straightforward.
- It avoids building an incomplete TMDL parser or requiring Microsoft’s .NET-only TMDL serializer.

The business rules and safe workflows from the Python TMDL implementation should still be ported where applicable. Native TMDL/PBIP round-tripping is deferred until there is a demonstrated requirement. Before claiming support for pre-existing TMDL models, Phase 6 must verify that requesting their definition in TMSL format and updating it as TMSL behaves correctly in the target tenant.

### 4.3 HTTP APIs instead of XMLA for the first release

Use:

- Fabric REST APIs for semantic model item CRUD, definitions, connection binding, and long-running-operation status.
- Power BI REST APIs for DAX execution and refresh operations.

Do not introduce TOM, ADOMD, XMLA, PowerShell, or a C# worker in the first release. They can be added behind adapters later if an API limitation is proven in testing.

### 4.4 Stateless long-running operations

Do not add a background-job system. When Fabric returns `202 Accepted`:

- Poll only for a small configurable time budget.
- Honor `Retry-After`.
- If still running, return the operation ID and current state.
- Let the client call `get_operation_status` or `get_refresh_status` later.

This works across Render restarts because Fabric, rather than this MCP server, owns operation state.

### 4.5 Safe full-definition updates

Fabric’s update-definition operation replaces the submitted model definition. Every object mutation therefore follows one shared pipeline:

```text
fetch current definition
        -> parse and normalize
        -> verify expected definition hash
        -> apply typed operations in memory
        -> validate references and invariants
        -> produce preview diff
        -> submit only after explicit apply
        -> poll Fabric operation
        -> read back and verify resulting hash
```

The `expectedDefinitionHash` prevents silently overwriting a model changed by another user or process. A preview is the default for destructive batches. Hard delete is disabled in the first release; semantic model deletion uses Fabric’s recoverable delete behavior.

### 4.6 Small dependency set

Expected runtime dependencies:

- The official MCP TypeScript server and Node HTTP transport packages.
- `@azure/identity` for service-principal and managed-identity credentials.
- `zod` for environment, tool-input, API-response, and model-boundary validation.
- A minimal HTTP integration supported by the MCP SDK if the SDK’s Node adapter does not provide the needed routing directly.

Use Node’s built-in `fetch`, `AbortController`, crypto, filesystem, and test-safe utility APIs. Do not add Axios, an ORM, a dependency-injection framework, or a general-purpose workflow engine.

Expected development dependencies are TypeScript, ESLint, Prettier, Vitest, and `tsx`. Pin exact dependency versions in the lockfile after checking the current stable MCP SDK release at implementation time.

## 5. Simple target architecture

```text
MCP client
    |
    | HTTPS + bearer authentication
    v
TypeScript MCP server
    |-- tool schemas and safety annotations
    |-- semantic model service
    |-- TMSL model mutation and validation
    |-- DAX validation/linting
    |-- secret-safe structured logging
    |
    |-- Fabric REST client --------> Semantic Model item/definition/connection APIs
    `-- Power BI REST client ------> DAX query and refresh APIs
```

Keep the code in one package with straightforward folders:

```text
src/
  config.ts
  errors.ts
  logging.ts
  auth.ts
  clients/
    fabric-client.ts
    powerbi-client.ts
  model/
    schema.ts
    normalize.ts
    mutate.ts
    validate.ts
    diff.ts
  services/
    semantic-model-service.ts
  mcp/
    tools.ts
    resources.ts
  http-server.ts
  index.ts
tests/
  fixtures/
  unit/
  integration/
  contract/
```

This is a logical separation, not a microservice design. Prefer functions and small modules; use classes only for stateful API clients where they improve clarity.

## 6. Proposed first-release MCP surface

The tool names and schemas are frozen in Phase 1. The smallest useful surface is:

| Tool                               | Purpose                                                                                               | Safety                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- |
| `list_workspaces`                  | List permitted Fabric workspaces                                                                      | Read-only                       |
| `list_semantic_models`             | List models in one workspace with pagination                                                          | Read-only                       |
| `get_semantic_model`               | Read item properties                                                                                  | Read-only                       |
| `get_semantic_model_definition`    | Read a normalized definition or selected summary                                                      | Read-only                       |
| `get_model_info`                   | Return bounded tables, columns, measures, relationships, partitions, and roles                        | Read-only                       |
| `create_semantic_model`            | Create a complete model from a typed specification                                                    | Write                           |
| `update_semantic_model_properties` | Rename or change description                                                                          | Write                           |
| `apply_model_changes`              | Preview or apply typed create/update/delete operations to model objects                               | Write/destructive as applicable |
| `delete_semantic_model`            | Soft-delete a model after explicit confirmation                                                       | Destructive                     |
| `bind_semantic_model_connection`   | Bind one model source reference to one Fabric connection                                              | Write                           |
| `validate_dax`                     | Execute a bounded validation probe against a deployed model                                           | Read-only                       |
| `execute_dax`                      | Execute a row-capped DAX query                                                                        | Read-only                       |
| `refresh_semantic_model`           | Start a refresh and return its ID/state                                                               | Write                           |
| `get_refresh_status`               | Read refresh status and diagnostics                                                                   | Read-only                       |
| `get_operation_status`             | Read Fabric long-running-operation status                                                             | Read-only                       |
| `model_snapshot`                   | Return normalized metadata plus its hash; optionally include the definition when explicitly requested | Read-only                       |
| `model_diff`                       | Compare a proposed specification/operation batch with the live definition                             | Read-only                       |
| `pre_deploy_gate`                  | Run structural, naming, DAX-lint, and connection checks                                               | Read-only                       |

`apply_model_changes` accepts a discriminated array of operations. Supported object types are expression/data source metadata, table, column, partition, measure, relationship, hierarchy, calculation group, and role. One mutation engine serves all operations, which avoids duplicating read-modify-validate-update logic across many tools. High-frequency convenience aliases such as `create_measure` should only be added after the core tool proves awkward in real MCP testing.

Large raw definitions and query results must not be returned by default. Read tools return summaries, counts, continuation information, and bounded results; a caller must explicitly request a full definition.

## 7. Cross-cutting coding rules

These rules apply in every phase:

- Enable all practical strict TypeScript compiler options; do not use untyped `any` at external boundaries.
- Validate environment variables at startup and every MCP tool argument with Zod.
- Validate external API responses before business logic consumes them.
- Keep secrets out of tool arguments, responses, exception text, and logs.
- Use structured errors with stable codes, HTTP status, Fabric request ID, retryability, and a redacted message.
- Set an `AbortController` timeout on every outbound request.
- Retry only safe/idempotent requests and transient `429`/`5xx` responses; honor `Retry-After` and use bounded exponential backoff with jitter.
- Never retry a create, mutation, or delete blindly. First reconcile its operation ID or read the destination state.
- Follow all continuation tokens when listing workspaces/models, subject to a configurable safety cap.
- Apply workspace allowlisting before any read or write.
- Cap DAX rows, response bytes, and execution time.
- Default destructive previews to no mutation, require explicit apply/confirmation, and mark tools with correct MCP safety annotations.
- Support `POWERBI_MCP_READONLY=true` as a server-side enforcement gate, not merely a tool hint.
- Log only metadata needed for support: operation, workspace/model IDs, duration, status, request ID, and result counts. Do not log access tokens, client secrets, full definitions, DAX result rows, or connection credentials.
- Preserve the original repository’s MIT notice when substantial code or rule definitions are ported.
- A phase is not complete while its required tests or acceptance checks are failing.

## 8. The six implementation phases

### Phase 1 — Contract, project foundation, and remote MCP skeleton

#### Objective

Create a small, testable TypeScript foundation and freeze exactly what the first release promises.

#### Work

- Record the reference repository commit used as the behavioral baseline.
- Create a single ESM TypeScript package with a pinned Node LTS version and lockfile.
- Configure strict TypeScript, ESLint, Prettier, Vitest, build scripts, and coverage reporting.
- Add validated configuration loading and a redacting structured logger.
- Create the HTTP process with `/health`, `/ready`, and a stateless `/mcp` endpoint.
- Add bearer-token protection for the Render test environment. Health endpoints reveal no secrets or tenant details.
- Register the proposed tool names, input/output schemas, annotations, resources, and server instructions with placeholder handlers that return a clear `NOT_IMPLEMENTED` domain error.
- Add a registry-parity test inspired by [`test_registry_parity.py`](./powerbi-mcp/tests/test_registry_parity.py), ensuring the advertised tool set, handlers, schemas, and safety metadata cannot drift.
- Write a short architecture decision record confirming the cloud-only scope and TMSL choice.

#### Phase gate

- Clean install, format check, lint, type-check, unit tests, and production build all pass.
- MCP Inspector can initialize the server and list the frozen tools.
- `/health` is public and minimal; `/mcp` rejects missing/invalid credentials.
- Logs remain valid and contain no configured secret when forced errors are exercised.
- No Fabric mutation exists yet.

### Phase 2 — Authentication and resilient Fabric/Power BI clients

#### Implementation status

Implemented on 2026-09-02. The credential, transport, Fabric, and Power BI boundaries are covered
by unit, integration, and real local HTTP end-to-end tests. The live tenant smoke check is an
explicit, read-only command and is run only when development-tenant credentials are available.

#### Objective

Provide one well-tested boundary around Microsoft authentication and HTTP behavior before adding model logic.

#### Work

- Implement a credential provider using Azure Identity:
  - Client-secret credentials for local development and Render.
  - `DefaultAzureCredential`/managed identity for Azure without changing calling code.
- Acquire and cache separate tokens for Fabric REST and Power BI REST resource scopes.
- Implement a small shared HTTP request helper with timeouts, redaction, request IDs, pagination, retry policy, and typed error mapping.
- Implement Fabric client calls for:
  - workspace discovery;
  - semantic model list/get/create/update/delete;
  - get/update definition;
  - connection binding;
  - long-running-operation state/result.
- Implement Power BI client calls for DAX execution, refresh start, refresh history, and refresh execution details.
- Use mock HTTP fixtures for success, pagination, `202`, `401`, `403`, `404`, `409`, `429`, `5xx`, timeout, malformed payload, and redaction cases.
- Perform a read-only live smoke check against an allowlisted development workspace when credentials are available.

#### Phase gate

- All client tests pass without a live tenant.
- Live authentication can list only allowlisted workspaces and semantic models.
- `429` handling demonstrably honors `Retry-After`.
- Fabric request IDs survive error translation; tokens and secrets do not.
- No model creation is performed in this phase.

### Phase 3 — Typed semantic-model definition and CRUD engine

#### Objective

Build the deterministic in-memory model layer that makes full-definition updates safe.

#### Work

- Define Zod schemas and TypeScript types for the supported TMSL subset and the user-facing `ModelSpec`.
- Create a known-good minimal `model.bim` and `definition.pbism` fixture.
- Implement base64 definition-part encoding/decoding.
- Implement normalization and stable hashing that ignore irrelevant ordering but preserve meaningful order such as hierarchy levels and calculation items.
- Implement typed operations for create/update/delete of tables, columns, partitions, measures, relationships, hierarchies, calculation groups, expressions, and roles.
- Enforce model invariants before submission:
  - unique names within their scopes;
  - referenced tables and columns exist;
  - relationship endpoints and cardinality are valid;
  - hierarchy levels refer to existing columns;
  - partitions have a supported mode/source shape;
  - measure expressions, format strings, and descriptions are present where required;
  - role permissions refer to existing tables;
  - deleting or renaming an object reports known dependents.
- Implement semantic diff output with added, changed, deleted, and potentially breaking sections.
- Port only the relevant DAX quoting, lint, naming, and dependency logic from the Python reference, backed by golden fixtures.
- Make every batch all-or-nothing in memory; the live definition is not called until the entire proposed result validates.

#### Phase gate

- A model fixture round-trips parse -> normalize -> serialize -> parse with no semantic diff.
- Every supported object type has create, update, delete, duplicate, missing-reference, and rollback-on-error tests.
- Serialization and hashes are deterministic across repeated runs.
- Golden tests cover apostrophes, spaces, Unicode, multiline DAX/M, calculation groups, composite keys where supported, and invalid references.
- No live Fabric model is mutated yet.

### Phase 4 — Fabric semantic-model lifecycle and safe live mutations

#### Objective

Connect the model engine to Fabric and complete item-level plus metadata-level CRUD.

#### Work

- Implement `create_semantic_model` from `ModelSpec`, producing required definition parts and handling synchronous or long-running responses.
- Implement read/list/model-summary operations with continuation handling and bounded output.
- Implement item property updates separately from definition updates.
- Implement `apply_model_changes` as fetch -> hash check -> mutate -> validate -> diff -> optionally submit -> read-back verification.
- Make preview/dry-run the default for destructive operation batches.
- Require `expectedDefinitionHash` on live updates after the initial model creation.
- Implement soft delete with explicit model ID and display-name confirmation. Do not expose hard delete.
- Implement connection binding one source reference at a time, reflecting Fabric’s API behavior.
- On a development Fabric workspace, run a controlled CRUD matrix against a uniquely named disposable model.
- Clean up the disposable model using soft delete after evidence is captured.

#### Phase gate

- The development workspace proves create, get, list, property update, definition update, connection bind where applicable, and soft delete.
- Representative object CRUD succeeds for table/column/partition, measure, relationship, hierarchy, calculation group, and role.
- A stale `expectedDefinitionHash` is rejected before update.
- Invalid references and invalid definitions never reach the Fabric update endpoint.
- Read-back hash and summary match the submitted definition after a successful operation.
- The test leaves no undeclared active Fabric artifacts behind.

### Phase 5 — DAX, refresh, MCP workflows, and safety controls

#### Objective

Expose the completed lifecycle through useful MCP tools and prove that a deployed model actually works.

#### Work

- Wire real service handlers into every first-release MCP tool.
- Use the JSON `executeQueries` Power BI REST endpoint first because it keeps the implementation and responses simple.
- Implement query validation, a default row cap, maximum response size, timeout, culture option, and clear handling of partial/truncated query responses.
- Implement scalar DAX validation by wrapping an expression in a minimal `EVALUATE ROW(...)` probe where appropriate.
- Implement refresh start and status polling without a local background worker.
- Add `model_snapshot`, `model_diff`, and `pre_deploy_gate` using normalized definitions rather than local files.
- Port the reference server’s useful controls:
  - response-boundary secret redaction;
  - read-only lockdown;
  - safety annotations;
  - DAX result caps;
  - destructive-operation confirmation;
  - stable structured output and domain error codes.
- Add MCP resources for a selected model summary and reference guidance only if they remain stateless and bounded.
- Test all tools through an MCP client, not only by calling service functions directly.
- Document the REST DAX limitations, particularly tenant settings and service-principal restrictions for RLS/SSO models. Do not add Arrow/XMLA support unless the target test model requires it.

#### Phase gate

- A deployed model refreshes/reframes successfully or returns an accurately diagnosed terminal failure.
- A DAX smoke query returns expected bounded structured results.
- Invalid DAX returns a useful redacted error without changing the model.
- Read-only mode blocks every mutating path, including indirect writes.
- Contract tests verify tool names, schemas, annotations, text output, and structured output.
- MCP Inspector and one real MCP host can complete the core workflow.

### Phase 6 — End-to-end verification and release candidate

#### Objective

Produce a reproducible container and evidence that all promised behavior is ready for Render testing.

#### Work

- Create a multi-stage, non-root Linux Docker image with a pinned Node runtime and production-only dependencies.
- Add `.dockerignore`, `.env.example`, operational README, health-check documentation, and deployment-variable tables.
- Add a minimal `render.yaml` or precise Render dashboard configuration, but do not deploy until the phase gate passes.
- Document the later Azure Container Apps settings using the same image; avoid building Azure infrastructure prematurely.
- Run the full disposable-model lifecycle from the definition of “end to end.”
- Run unit, contract, mocked integration, live Fabric integration, and container smoke tests from a clean checkout.
- Test process shutdown, timeout, retry, 202-resume, cold start, malformed input, unauthorized access, workspace allowlist, concurrent hash conflict, API throttling, and Fabric failure responses.
- Verify that no secrets, DAX rows, full model definitions, or connection credentials appear in logs.
- Produce a short test-evidence report listing tenant-independent tests and the exact live operations verified.
- Tag the release candidate only when all gates pass.

#### Phase gate

- A clean checkout produces the same lockfile-based build and container.
- The container runs as a non-root user, binds to `0.0.0.0:$PORT`, and passes `/health`, `/ready`, and authenticated `/mcp` checks.
- All automated tests pass; no skipped critical-path test is accepted silently.
- The complete live Fabric lifecycle passes twice to catch accidental retained state.
- The release candidate has no required local files or databases and survives a process restart.
- Documentation is sufficient for a different developer to run locally and configure Render without reading source code.

## 9. Test strategy

Use four layers and keep each one purposeful:

1. **Unit tests:** normalization, hashing, mutations, validation, DAX linting, redaction, and configuration.
2. **Contract tests:** MCP schemas/annotations/outputs and Microsoft API request/response fixtures.
3. **Mocked integration tests:** service workflows across clients and model engine, including failures and retries.
4. **Live disposable integration tests:** one allowlisted Fabric development workspace using uniquely named artifacts and guaranteed cleanup.

Do not chase a vanity coverage percentage. Require complete branch coverage for destructive gates, hash conflicts, redaction, retries, model validation, and cleanup. Use coverage elsewhere to reveal gaps rather than as the sole quality measure.

Live tests must be opt-in, must refuse a workspace not explicitly allowlisted, and must prefix all created artifacts with a test-run identifier. Cleanup runs in `finally`; a separate read-only cleanup report identifies leftovers if Fabric is unavailable during teardown.

## 10. Configuration and secret handling

Expected configuration:

| Variable                       | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `NODE_ENV`                     | Runtime mode                                                         |
| `PORT`                         | HTTP port supplied by Render/Azure                                   |
| `MCP_API_KEY`                  | Render-stage bearer secret; never logged                             |
| `AZURE_TENANT_ID`              | Entra tenant for local/Render service principal                      |
| `AZURE_CLIENT_ID`              | App registration or user-assigned managed identity client ID         |
| `AZURE_CLIENT_SECRET`          | Render/local secret only; absent when Azure managed identity is used |
| `FABRIC_ALLOWED_WORKSPACE_IDS` | Comma-separated hard allowlist                                       |
| `POWERBI_MCP_READONLY`         | Enforced write lockdown                                              |
| `DAX_MAX_ROWS`                 | Server-side maximum with a conservative default                      |
| `HTTP_TIMEOUT_MS`              | Outbound request timeout                                             |
| `LRO_POLL_BUDGET_MS`           | Maximum synchronous polling budget                                   |
| `LOG_LEVEL`                    | Structured log verbosity without secret or row logging               |

No tenant secret, token, connection credential, or API key may be accepted as an MCP tool parameter. On Render they are stored as service secrets. On Azure, managed identity should replace the client secret wherever the required Fabric/Power BI operation supports it.

## 11. Prerequisites outside the codebase

Before Phase 2 live testing, obtain:

- A Fabric development workspace on suitable capacity.
- A disposable or test data source suitable for the selected storage mode.
- A service principal placed in the required Fabric admin-approved security group if tenant policy uses one.
- The Fabric tenant setting allowing service principals/managed identities to use Fabric APIs.
- The Power BI tenant setting allowing service principals to use Power BI APIs.
- Contributor access for semantic model creation and appropriate ownership for connection binding.
- Read and Build permissions for DAX execution.
- A Fabric connection with test credentials when binding is required.

Use a dedicated development workspace. Do not test destructive paths in a production workspace.

## 12. Deployment after all six phases

Deployment is intentionally outside the six implementation phases. Phase 6 only prepares and verifies the release candidate.

### 12.1 Render test deployment

- Deploy the Docker image as one Render Web Service.
- Bind the service to `0.0.0.0:$PORT` and configure `/health` as the health-check path.
- Store service-principal values and `MCP_API_KEY` as Render secrets.
- Keep the server stateless; do not depend on Render’s filesystem or add a persistent disk.
- Start with one instance and no external database.
- Test MCP initialization, tool discovery, read operations, a disposable model lifecycle, DAX, refresh, authorization failures, and restart behavior.
- Treat a free Render instance only as a functional test environment: it can spin down after inactivity and its filesystem is ephemeral.

### 12.2 Azure deployment after Render passes

- Push the same image to Azure Container Registry.
- Deploy it to Azure Container Apps with HTTPS ingress and a health probe.
- Enable a managed identity and grant only the required Fabric workspace permissions.
- Replace the Render API-key layer with Microsoft Entra protection through Container Apps authentication when compatible with the chosen MCP client.
- Send logs to Log Analytics and retain the same redaction policy.
- Begin with one revision and minimal replicas; add scaling or private networking only when usage demonstrates a need.

## 13. Main risks and simple mitigations

| Risk                                                      | Mitigation                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fabric APIs or payloads change                            | Keep all endpoint details in two small API clients, validate responses, pin contract fixtures, and verify against a live development tenant in every release. |
| Full-definition update overwrites concurrent work         | Require `expectedDefinitionHash`, show a semantic diff, and reject stale updates.                                                                             |
| TMSL conversion of an existing TMDL model is not lossless | Limit the first guarantee to models created by this server until the Phase 6 round-trip test passes.                                                          |
| Invalid DAX is discovered only after deployment           | Run static lint first, validate executable expressions against a deployed test model, and use a pre-deploy preview plus post-update smoke query.              |
| DAX REST service-principal limitations with RLS/SSO       | Document the limitation; add the newer Arrow DAX endpoint, delegated identity, or XMLA only when a real target model requires it.                             |
| Connection credentials cannot live in model files         | Bind to a separately managed Fabric connection and never return its credentials through MCP.                                                                  |
| Long Fabric operations exceed an HTTP request             | Use bounded polling and resumable status tools; do not introduce a job queue.                                                                                 |
| Render loses local files or restarts                      | Keep the server stateless and store authoritative state in Fabric; emit logs to the platform.                                                                 |
| An agent invokes a destructive operation incorrectly      | Use MCP annotations plus enforced preview, confirmation, allowlisting, soft delete, read-only mode, and hash concurrency checks.                              |
| MCP responses become too large                            | Return summaries and caps by default; require explicit full-definition export.                                                                                |

## 14. Research basis

### Local reference

- [Reference architecture](./powerbi-mcp/docs/ARCHITECTURE.md)
- [Reference tool catalog](./powerbi-mcp/docs/TOOLS.md)
- [Reference limitations and roadmap](./powerbi-mcp/README.md#limitations)
- [Reference agent safety rules](./powerbi-mcp/AGENTS.md)
- [MIT license](./powerbi-mcp/LICENSE)

### Primary platform documentation

- [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP TypeScript server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [Fabric semantic model definition formats](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/semantic-model-definition)
- [Create a semantic model](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/create-semantic-model)
- [Get a semantic model definition](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/get-semantic-model-definition)
- [Update a semantic model definition](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/update-semantic-model-definition)
- [List semantic models](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/list-semantic-models)
- [Delete a semantic model](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/delete-semantic-model)
- [Bind a semantic model connection](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/bind-semantic-model-connection)
- [Fabric long-running operations](https://learn.microsoft.com/en-us/rest/api/fabric/articles/long-running-operation)
- [Fabric identity support](https://learn.microsoft.com/en-us/rest/api/fabric/articles/identity-support)
- [DefaultAzureCredential for JavaScript](https://learn.microsoft.com/en-us/javascript/api/%40azure/identity/defaultazurecredential)
- [List Fabric workspaces](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/list-workspaces)
- [Get Fabric operation state](https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-state)
- [Get Fabric operation result](https://learn.microsoft.com/en-us/rest/api/fabric/core/long-running-operations/get-operation-result)
- [Execute DAX queries through Power BI REST](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)
- [Refresh a semantic model](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/refresh-dataset-in-group)
- [Get semantic model refresh history](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/get-refresh-history-in-group)
- [Inspect refresh execution](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/get-refresh-execution-details-in-group)
- [Render Web Services](https://render.com/docs/web-services)
- [Render free-service limitations](https://render.com/docs/free)
- [Azure Container Apps overview](https://learn.microsoft.com/en-us/azure/container-apps/overview)
- [Azure Container Apps ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)
- [Managed identities in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
- [Authentication in Azure Container Apps](https://learn.microsoft.com/en-us/azure/container-apps/authentication)

## 15. Final planning decision

Proceed with the six phases in order and do not start a later phase until the current phase gate passes. The first release is considered successful when it manages a disposable Fabric semantic model from creation through DAX validation and safe deletion through MCP, using one stateless TypeScript container. Features that do not support that workflow remain deferred until real usage justifies them.
