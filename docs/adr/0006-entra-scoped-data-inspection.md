# ADR 0006: Entra-scoped workspaces and bounded Fabric data inspection

- Status: Accepted
- Date: 2026-09-03

## Context

Workspace access must follow the configured Entra identity's Fabric roles and item permissions
without duplicating authorization in deployment configuration. Agents also need Lakehouse and
Warehouse metadata and bounded samples to design semantic models against real source structures.

Fabric REST supports service-principal workspace, Lakehouse, Warehouse, and Lakehouse-table reads.
Warehouse and Lakehouse SQL analytics endpoints support Entra service principals over TDS. Fabric
item REST APIs do not return complete column metadata or table rows.

## Decision

- Do not configure a runtime workspace ID or maintain a local workspace authorization list.
- List every workspace returned by Fabric for the configured Entra identity.
- Validate UUIDs locally, then let Fabric workspace roles, item permissions, and SQL permissions
  authorize every operation.
- Add read-only Lakehouse/Warehouse list and get tools plus Lakehouse Delta-table listing.
- Use the SQL endpoint only for fixed `INFORMATION_SCHEMA` metadata queries and server-generated
  `SELECT TOP` table samples.
- Do not expose arbitrary SQL. Quote all identifiers, parameterize limits and filters, cap rows and
  response bytes, set connection/request timeouts, require TLS, and restrict endpoints to
  `*.datawarehouse.fabric.microsoft.com`.
- Keep `POWERBI_MCP_READONLY` as the independent semantic-model mutation gate.
- Require `FABRIC_TEST_WORKSPACE_ID` only in destructive live-test scripts; the application never
  reads that variable.

## Consequences

Deployment needs four secrets rather than five: the MCP bearer key and three Entra application
values. Granting the application access to another Fabric workspace makes it discoverable without a
redeploy, so least-privilege Fabric role assignment is now the administrative scope boundary.

Schema inspection and sampling require outbound TCP port `1433` and a token for
`https://database.windows.net/.default`. SQL query results remain bounded and are never logged.
Lakehouse table listing uses a preview Fabric REST API and is therefore isolated behind a typed
client contract and response validation.
