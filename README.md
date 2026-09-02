# Fabric Semantic Model MCP Server

A remote Model Context Protocol server for managing Microsoft Fabric semantic models. The
project is implemented in strict TypeScript and follows the six-phase plan in
[`implementation.md`](./implementation.md).

## Current status

Phases 1 through 5 are implemented. All 18 frozen MCP tools now use the tested Microsoft clients,
semantic-model lifecycle service, deterministic model engine, bounded JSON DAX execution, refresh
tracking, snapshots, diffs, and pre-deployment checks. Phase 6 container and release-candidate work
remains.

Available now:

- Stateless Streamable HTTP at `POST /mcp`.
- Public, minimal `GET /health` and `GET /ready` probes.
- Constant-time bearer-token verification for `/mcp`.
- Host and browser-origin allowlists.
- Frozen tool input/output schemas and safety annotations.
- Static capability and safety resources.
- Structured logs with recursive secret redaction.
- Azure Identity client-secret and `DefaultAzureCredential` authentication modes.
- Separate cached tokens for the Fabric and Power BI resource scopes.
- Workspace-allowlisted Fabric and Power BI clients with read-only enforcement.
- Bounded HTTP timeouts, response sizes, pagination, typed errors, request IDs, and safe retries.
- Unit, contract, integration, and real MCP-client end-to-end tests.
- Strict user-facing `ModelSpec` and supported TMSL `model.bim` contracts.
- TMSL `model.bim` and `definition.pbism` base64 definition codecs with optional-part preservation.
- Atomic CRUD batches for data sources, expressions, tables, columns, partitions, measures,
  relationships, hierarchies, calculation groups/items, and roles.
- Semantic invariants, dependency conflict reporting, stable SHA-256 hashes, and semantic diffs.
- DAX quoting, reference extraction, and advisory lint rules ported from the Python reference.
- A deliberately partial DAX function catalog whose unknown-function findings are informational and
  explicitly non-blocking; Fabric or Power BI remains the authoritative DAX validator.
- A golden local definition fixture covering Unicode, apostrophes, multiline DAX/M, all supported
  partition sources, calculation groups, hierarchies, relationships, and RLS.
- Preview-first create, property update, definition mutation, connection binding, and permanent-delete
  lifecycle operations.
- Optimistic concurrency through required semantic definition hashes on model updates.
- Bounded Fabric long-running-operation polling with operation handles returned on timeout.
- Post-write definition hash and object-count verification.
- Repeated-ID, exact-name, and explicit irreversible confirmation for permanent deletion.
- Scoped continuation tokens and bounded model metadata summaries.
- Scalar and query-form DAX validation against a deployed model.
- Server-capped JSON DAX rows, output bytes, truncation reasons, and stable query errors.
- Preview-first transactional refresh start plus resumable terminal-status diagnostics.
- Normalized model snapshots, operation-aware diffs, and configurable pre-deployment checks.
- Response-boundary secret redaction and centralized read-only enforcement before applied workflows.

## Requirements

- Node.js 24.14.0
- npm 11.9.0

The exact Node version is recorded in `.nvmrc` and `.node-version`. Runtime and development
dependency versions are exact and committed in `package-lock.json`.

## Local setup

```powershell
npm ci
Copy-Item .env.example .env
```

Replace `MCP_API_KEY` in `.env` with at least 32 random characters. Configure the Azure and
workspace variables described below before running a live client check. This project does not load
`.env` automatically, so export the variables through your shell or process manager before
starting it. For example:

```powershell
$env:MCP_API_KEY = "replace-with-a-long-random-development-key"
npm run dev
```

The default address is `http://localhost:3000`. Requests to `/mcp` must include:

```text
Authorization: Bearer <MCP_API_KEY>
```

`MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` are comma-separated hostname lists without schemes
or ports. `localhost`, `127.0.0.1`, and `[::1]` are the defaults. A Render hostname supplied in
`RENDER_EXTERNAL_HOSTNAME` is added to the host allowlist automatically.

## Verification

Run the entire local quality gate:

```powershell
npm run check
```

The gate checks formatting, lint rules, TypeScript types, coverage thresholds, and the production
build. To run only the protocol-level end-to-end test:

```powershell
npm run test:e2e
```

Those tests start the HTTP service on an ephemeral port and use the official MCP TypeScript client
to initialize, list tools, list and read resources, and call every frozen tool through the Phase 5
workflow router and bearer authentication. They run the Microsoft clients against a real local HTTP fixture to verify
audience-specific bearer tokens, request serialization, response parsing, and allowlisting. The
model pipeline test validates a golden TMSL definition, applies a multi-object atomic batch,
serializes it into Fabric definition parts, reads it back, and verifies an identical semantic hash.

An opt-in live smoke check performs only workspace and semantic-model reads:

```powershell
npm run test:live
```

The command requires `MCP_API_KEY`, valid Azure credentials, at least one
`FABRIC_ALLOWED_WORKSPACE_IDS` entry, and `POWERBI_MCP_READONLY=true`. It refuses to run when
read-only mode is disabled.

The Phase 4 live lifecycle check is intentionally separate because it creates, mutates, and
permanently deletes one uniquely named disposable model. Fabric item recovery does not currently
support semantic models, so the check requires exactly one development workspace, write mode, an
explicit mutation acknowledgement, and a separate permanent-delete acknowledgement:

```powershell
$env:PHASE4_LIVE_MUTATION = "true"
$env:PHASE4_LIVE_PERMANENT_DELETE = "true"
$env:POWERBI_MCP_READONLY = "false"
npm run test:live:phase4
```

The script loads local values from `.env`, previews creation first, verifies representative object
create/update/delete batches and a stale-hash rejection, then permanently deletes only the model
created by that run after repeating its ID and exact current name. Its self-contained model has no
external data source, so connection binding is reported as not applicable. Connection binding is
covered by unit and real-HTTP end-to-end fixtures.

The Phase 5 live check creates a uniquely named self-contained model through an actual local MCP
HTTP client, runs snapshot/diff/gate workflows, starts and follows a full refresh, validates both
valid and invalid DAX, executes a one-row smoke query, and permanently deletes the disposable model:

```powershell
$env:PHASE5_LIVE_MUTATION = "true"
$env:PHASE5_LIVE_PERMANENT_DELETE = "true"
$env:POWERBI_MCP_READONLY = "false"
npm run test:live:phase5
```

It requires exactly one allowlisted development workspace. Cleanup runs in `finally`, with a direct
Fabric fallback if the MCP connection is unavailable.

## Configuration

| Variable                       |    Required | Default        | Description                                                                      |
| ------------------------------ | ----------: | -------------- | -------------------------------------------------------------------------------- |
| `MCP_API_KEY`                  |         Yes | None           | MCP bearer secret with at least 32 characters.                                   |
| `NODE_ENV`                     |          No | `development`  | `development`, `test`, or `production`.                                          |
| `HOST`                         |          No | `0.0.0.0`      | HTTP bind host.                                                                  |
| `PORT`                         |          No | `3000`         | HTTP port.                                                                       |
| `MCP_ALLOWED_HOSTS`            |          No | Local hosts    | Host-header allowlist.                                                           |
| `MCP_ALLOWED_ORIGINS`          |          No | Host allowlist | Browser Origin-hostname allowlist.                                               |
| `RENDER_EXTERNAL_HOSTNAME`     |          No | None           | Render hostname appended to allowed hosts.                                       |
| `LOG_LEVEL`                    |          No | `info`         | `debug`, `info`, `warn`, or `error`.                                             |
| `AZURE_AUTH_MODE`              |          No | `auto`         | `auto`, `client-secret`, or `default`.                                           |
| `AZURE_TENANT_ID`              | Conditional | None           | Tenant UUID; required with client-secret authentication.                         |
| `AZURE_CLIENT_ID`              | Conditional | None           | Application UUID for Render or managed-identity client UUID for Azure.           |
| `AZURE_CLIENT_SECRET`          | Conditional | None           | Required for client-secret authentication; keep it in the platform secret store. |
| `FABRIC_ALLOWED_WORKSPACE_IDS` |          No | Empty          | Comma-separated workspace UUIDs; an empty list denies every workspace.           |
| `POWERBI_MCP_READONLY`         |          No | `true`         | Blocks create, update, delete, bind, and refresh calls when true.                |
| `HTTP_TIMEOUT_MS`              |          No | `30000`        | Per-attempt external HTTP timeout.                                               |
| `HTTP_MAX_RETRIES`             |          No | `2`            | Retry count for explicitly safe reads only.                                      |
| `HTTP_MAX_PAGES`               |          No | `100`          | Pagination safety limit.                                                         |
| `HTTP_MAX_RESPONSE_BYTES`      |          No | `10485760`     | Maximum external response body size.                                             |
| `LRO_POLL_BUDGET_MS`           |          No | `60000`        | Maximum time spent synchronously polling one Fabric long-running operation.      |
| `DAX_MAX_ROWS`                 |          No | `1000`         | Server-side maximum DAX rows returned to an MCP caller.                          |
| `DAX_MAX_RESPONSE_BYTES`       |          No | `1048576`      | Maximum serialized DAX/tool data returned to an MCP caller.                      |

Configuration is validated before the server binds a port. Error messages name invalid variables
but never include their values.

## Frozen Phase 1 contract

The MCP surface is defined once in `src/mcp/registry.ts`, and a parity test prevents the advertised
tools, safety classification, schemas, and write-tool set from drifting. The common tool result is:

```json
{
  "ok": true,
  "status": "success",
  "message": "Semantic models listed.",
  "data": { "value": [] },
  "error": null
}
```

The frozen tools are documented in [`implementation.md`](./implementation.md#6-proposed-first-release-mcp-surface).
The server publishes `fabric://reference/capabilities` and `fabric://reference/safety` as static,
read-only MCP resources.

## Security boundary

- Never pass credentials, access tokens, tenant secrets, or connection secrets as MCP arguments.
- Health and readiness responses expose only a status value.
- Missing and invalid bearer credentials receive the same response.
- The MCP service is stateless; no model definitions or credentials are written locally.
- An empty workspace allowlist denies all Fabric and Power BI client calls.
- External writes are blocked by default. Unsafe requests are never automatically retried.
- Applied MCP workflows are rejected at the central router when read-only mode is enabled, before
  any preparatory reads or external writes occur.
- Query rows, full model definitions, and refresh exception payloads are never logged.

Bearer authentication is the initial Render test boundary. Microsoft Entra protection is planned
for the later Azure deployment phase.

## DAX and refresh REST limitations

The first release deliberately uses Power BI's JSON
[`executeQueries`](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)
endpoint. Microsoft limits it to one query and one result table, 100,000 rows or 1,000,000 values,
15 MB, and 120 requests per minute. This server applies lower configurable output limits. Power BI
can return partial data with HTTP 200 when a service limit is reached; the MCP result reports
`truncated`, `truncationReasons`, and bounded warnings.

The Power BI tenant's Dataset Execute Queries REST API integration setting must be enabled, and the
caller needs semantic-model Read and Build permissions. Microsoft does not support service-principal
JSON queries against models with RLS or SSO enabled. The JSON contract has no request-culture field:
omit `culture` to use the deployed model culture. Supplying a culture returns
`DAX_CULTURE_OVERRIDE_UNSUPPORTED` rather than silently ignoring it. The newer Arrow endpoint can
support explicit culture in a future opt-in adapter without changing this JSON-first contract.

Refresh starts use the asynchronous enhanced-refresh contract with transactional commit mode and no
service-principal-incompatible notify option. `get_refresh_status` follows Power BI-owned state and
returns bounded messages extracted from diagnostics instead of returning raw exception JSON.

## Behavioral reference

The Python behavioral reference is
[`sulaiman013/powerbi-mcp`](https://github.com/sulaiman013/powerbi-mcp) at commit
`977b4d126fed9dee7b8d6dade6d45dc5ac7064fb`. It is retained locally under the ignored
`powerbi-mcp/` directory and is not bundled with this TypeScript service.
