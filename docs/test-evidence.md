# Production verification evidence

## Release

- Version: `1.1.2`
- Verification date: 2026-09-03
- Runtime: Node.js `24.14.0`
- MCP contract: 25 tools and two read-only resources
- Deployment targets: Render and Azure Container Apps

## Required quality gates

`npm run check` is the mandatory source-quality gate. It verifies formatting, lint rules, strict
TypeScript compilation, unit tests, contract tests, mocked Microsoft API integration tests, real
MCP-client end-to-end tests, coverage thresholds, and the production build.

| Risk or behavior                                                 | Automated evidence                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Authentication and request-boundary validation                   | HTTP integration tests and `tests/e2e/oauth-mcp.test.ts`             |
| Host and browser-origin enforcement                              | `tests/integration/http.test.ts`, `tests/unit/config.test.ts`        |
| Secret and response redaction                                    | `tests/unit/logging.test.ts`, `tests/e2e/mcp.test.ts`                |
| Entra token audience separation and caching                      | `tests/unit/identity.test.ts`, `tests/e2e/microsoft-clients.test.ts` |
| Timeout, response limit, retry, and throttling policy            | `tests/integration/http-client.test.ts`                              |
| Typed Fabric and Power BI request/response handling              | client integration and MCP workflow tests                            |
| Entra/Fabric workspace authorization boundary                    | Fabric/Power BI client, configuration, and workflow tests            |
| Deterministic model encoding and validation                      | model unit tests and `tests/e2e/model-engine.test.ts`                |
| Calculated-table and server row-number TMSL compatibility        | `tests/unit/model/codec.test.ts`                                     |
| Direct Lake binary-column rejection before mutation              | model validation and MCP workflow tests                              |
| Atomic object CRUD and dependency conflicts                      | model engine and lifecycle-service tests                             |
| Definition hash concurrency protection                           | lifecycle-service and semantic-model end-to-end tests                |
| Preview-first writes and central read-only enforcement           | workflow, lifecycle, and client tests                                |
| Permanent-delete confirmation                                    | contract, lifecycle-service, and semantic-model end-to-end tests     |
| Service-principal DAX, Arrow decoding, row/response bounds       | Arrow parser, workflow, and Power BI client tests                    |
| Refresh and long-running-operation resumption                    | lifecycle, workflow, and client tests                                |
| Lakehouse/Warehouse discovery and response parsing               | Fabric client, data-service, and MCP end-to-end tests                |
| Fabric SQL host restriction, token scope, and query construction | `tests/integration/fabric-sql-client.test.ts`                        |
| Bounded source schema and table reads                            | Fabric SQL client, data-service, and workflow tests                  |

`npm run test:container` is the mandatory image gate. It builds the production Dockerfile and
verifies the pinned Node.js version, production-only dependencies, non-root execution, read-only
filesystem compatibility, dropped Linux capabilities, health/readiness probes, bearer rejection,
authenticated MCP discovery, restart recovery, secret-free logs, and graceful SIGTERM shutdown.

## Verified results

Release `1.1.2` adds regression coverage for Fabric-generated `rowNumber` and
`calculatedTableColumn` TMSL objects and blocks unsupported Direct Lake binary columns before a
definition reaches Fabric. Pre-commit verification on 2026-09-03 produced these results:

- `npm run check`: 25 test files and 208 tests passed; statement coverage was 93.04%, branch
  coverage was 82.23%, function coverage was 93.98%, line coverage was 93.92%, and the production
  TypeScript build completed successfully.
- `npm run test:e2e`: five MCP end-to-end test files and eight scenarios passed.
- `npm audit --omit=dev --audit-level=high`: no production dependency vulnerabilities were found.
- The production image and runtime smoke gate is required to pass in GitHub Actions for the release
  commit. The local Docker Desktop Linux engine was unavailable during pre-commit verification, so
  no local container result is claimed here.

The preceding production `1.1.1` source tree and deployed DAX path passed the following checks on
2026-09-03:

- `npm run check`: 25 test files and 204 tests passed; line coverage was 93.83%; the production
  TypeScript build completed successfully.
- `npm audit --omit=dev --audit-level=high`: no production dependency vulnerabilities were found.
- GitHub Actions run `33729127640` passed both the quality gate and production container gate for
  commit `96a32ce9cfc6825672863664f1caed1ad383d756`.
- The deployed MCP listed current semantic models and confirmed that the deleted test model was no
  longer present. A bounded literal DAX query and an `en-US` culture query both succeeded through
  the service principal. An invalid measure returned the expected Arrow error-rowset result, and a
  nonexistent model ID returned the non-retryable `SEMANTIC_MODEL_NOT_FOUND` contract.

The immediately preceding `1.1.0` production acceptance baseline also passed these live checks on
2026-09-03; the `1.1.1` change did not modify their implementation paths:

- OAuth interoperability covered both MCP protected-resource metadata routes, standards-compliant
  bearer challenges, required-scope enforcement, protocol initialization, tool discovery, and
  signed-JWT verification against a remote JWKS. API-key compatibility remained covered by the
  existing HTTP, MCP, and container gates.
- `npm run test:live:data`: the configured service principal discovered three authorized
  workspaces, 27 Lakehouses, and two Warehouses; listed nine Lakehouse tables; inspected 25 SQL
  endpoint columns; and completed a bounded one-column, one-row sample without exposing IDs,
  secrets, SQL text, or row values in the result.
- `npm run test:live`: the configured service principal discovered three authorized workspaces and
  30 semantic models using enforced read-only mode and aggregate-only output.
- `npm run test:live:full`: two consecutive disposable semantic-model lifecycles completed through
  a real MCP HTTP client. Both runs passed create, property update, definition readback, object CRUD,
  stale-hash rejection, diff and deployment gate, refresh, DAX validation/execution, permanent
  deletion, and post-delete absence verification.

## Live mutation verification result

The guarded `npm run test:live:full` acceptance check passed for release `1.1.0` on 2026-09-03. It
executed two complete, independent lifecycles against the approved non-production workspace. Both
runs returned `createVerified`, `propertyUpdateVerified`, `staleHashRejected`, `objectCrudVerified`,
`definitionReadbackVerified`, `diffAndGateVerified`, `refreshVerified`, `daxVerified`, and
`permanentDeleteVerified` as true. Both runs returned `activeArtifactLeft` as false, confirming that
the disposable semantic models were permanently removed.

## Live mutation verification contract

`npm run test:live:full` performs two complete sequential lifecycles through a real MCP HTTP client.
It is opt-in and refuses to start unless all of the following are explicitly configured:

- `FABRIC_TEST_WORKSPACE_ID` identifies one approved non-production workspace.
- `POWERBI_MCP_READONLY=false` enables applied mutations.
- `LIVE_FULL_MUTATION=true` acknowledges model creation and update.
- `LIVE_FULL_PERMANENT_DELETE=true` acknowledges irreversible cleanup.

Each run performs the following operations:

1. Initialize MCP and verify the published 25-tool contract.
2. Confirm the configured non-production workspace is visible to the service principal.
3. Preview and create a uniquely named, self-contained semantic model.
4. Read and update item properties and verify the definition and semantic hash.
5. Create, update, and delete representative DAX measure and hierarchy objects.
6. Reject a stale definition hash without mutation and verify hash restoration after object cleanup.
7. Generate a snapshot and diff and pass the deployment validation gate.
8. Preview and start a full refresh and poll it to a successful terminal state.
9. Validate correct DAX, reject invalid DAX, and execute a bounded one-row DAX query.
10. Permanently delete the exact disposable model using repeated ID, exact name, explicit
    confirmation, and post-delete absence verification.

Cleanup runs in `finally` with a direct Fabric fallback when the MCP connection is unavailable. A
failed cleanup fails the verification and must be resolved before deployment.

`npm run test:live:direct-lake` is the guarded acceptance check for Lakehouse-backed Direct Lake
models. In addition to the workspace and mutation acknowledgements, it requires
`FABRIC_TEST_LAKEHOUSE_ID` and `FABRIC_TEST_LAKEHOUSE_TABLE`. The check inspects the source table
through MCP, creates a disposable model with a shared OneLake named expression and entity partition,
verifies the `expressionSource` after Fabric readback, completes a refresh and DAX query, and then
permanently deletes the item. It reports only aggregate evidence and never emits source rows.

## Production acceptance

Deployment acceptance requires all of the following:

- `/health` and `/ready` return HTTP 200 and reveal only service status.
- `/mcp` returns HTTP 401 without credentials and initializes with the configured API key in private
  compatibility mode or a valid audience- and scope-bound JWT in OAuth mode.
- OAuth mode publishes root and path-specific protected-resource metadata using only the configured
  canonical public origin.
- The server publishes exactly 25 tools and two read-only resources.
- Workspace discovery is limited to the Entra identity's Fabric permissions.
- Read-only mode blocks every applied create, update, delete, bind, and refresh workflow.
- A process restart requires no local state recovery.
- Logs contain no configured secrets, model definitions, DAX rows, or sampled table values.
- Lakehouse/Warehouse metadata and bounded sampling succeed when SQL permissions are present.
- Any approved disposable lifecycle completes and permanently removes its created model.
