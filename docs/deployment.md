# Deployment runbook

This runbook deploys the same stateless production image first to Render and later to Azure
Container Apps. It does not require a database or persistent disk. Complete the release gates in
[`test-evidence.md`](./test-evidence.md) before enabling write mode in any hosted environment.

## Production image contract

The root [`Dockerfile`](../Dockerfile) uses the exact Node.js version from `.node-version`, builds
TypeScript in a separate stage, prunes development dependencies, and runs `node dist/index.js` as
the unprivileged `node` user. The process binds to `0.0.0.0:$PORT`. `/health` is the liveness
endpoint, `/ready` is the readiness endpoint, and `/mcp` is the authenticated Streamable HTTP MCP
endpoint.

Build and verify the image locally:

```text
npm ci
npm run check
npm run test:container
```

The container smoke test builds from the committed Dockerfile and verifies the pinned Node
version, non-root UID, production-only dependencies, a read-only root filesystem, dropped Linux
capabilities, health and readiness, unauthenticated rejection, authenticated MCP discovery, cold
restart recovery, secret-free logs, and clean SIGTERM shutdown.

## Runtime configuration

Set configuration only at runtime. Never pass Azure credentials or `MCP_API_KEY` as Docker build
arguments.

| Variable               | Render                      | Azure Container Apps                                     |
| ---------------------- | --------------------------- | -------------------------------------------------------- |
| `NODE_ENV`             | `production`                | `production`                                             |
| `HOST`                 | `0.0.0.0`                   | `0.0.0.0`                                                |
| `PORT`                 | Use Render's injected value | `3000`; ingress target port `3000`                       |
| `MCP_API_KEY`          | Secret                      | Secret reference or Key Vault reference                  |
| `AZURE_AUTH_MODE`      | `client-secret`             | `default` for managed identity                           |
| `AZURE_TENANT_ID`      | Secret environment value    | Omit for system-assigned managed identity                |
| `AZURE_CLIENT_ID`      | Secret environment value    | Omit for system-assigned; set for user-assigned identity |
| `AZURE_CLIENT_SECRET`  | Secret                      | Omit when using managed identity                         |
| `POWERBI_MCP_READONLY` | Start with `true`           | Start with `true`                                        |
| `LOG_LEVEL`            | `info`                      | `info`                                                   |

Keep the remaining timeout, pagination, polling, DAX, and data-inspection limits at the values in
`.env.example` unless a measured live test justifies changing one. Workspace access comes entirely
from the configured Entra identity's Fabric roles, item permissions, and SQL permissions.
`POWERBI_MCP_READONLY=true` blocks every applied create, update, delete, bind, and refresh workflow.

## Render deployment

The root [`render.yaml`](../render.yaml) is the deployment contract. It creates one Docker web
service, uses `/health`, allows 30 seconds for graceful shutdown, and prompts for every credential
or tenant-specific value instead of committing it.

1. Create a new Render Blueprint from this repository and select `render.yaml`.
2. Enter strong values for `MCP_API_KEY`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
   `AZURE_CLIENT_SECRET`. No workspace-ID environment variable is used.
   Confirm the tenant setting **Service principals can use Fabric APIs** is enabled and assign the
   application only the Fabric workspace/item roles it needs.
3. Leave `POWERBI_MCP_READONLY=true` for the initial deployment. Render provides `PORT` and
   `RENDER_EXTERNAL_HOSTNAME`; the server adds the external hostname to its host allowlist.
4. Wait for the deployment and `/health` check to succeed. Verify `GET /ready` returns HTTP 200.
5. Connect an MCP client to `https://<service-host>/mcp` with
   `Authorization: Bearer <MCP_API_KEY>`. Verify initialization, tool discovery, and read-only
   workspace, model, Lakehouse, and Warehouse listing.
   Schema inspection and table sampling additionally require outbound TCP `1433` from Render to
   `*.datawarehouse.fabric.microsoft.com` and SQL access for the service principal.
6. Change `POWERBI_MCP_READONLY` to `false` only for a controlled disposable lifecycle test. Keep
   the Entra application assigned only to intended non-production workspaces and restore read-only
   mode afterward if hosted writes are no longer required.

Do not attach a persistent disk. Roll back by selecting the last passing deployment in Render,
then verify `/health`, `/ready`, and authenticated MCP discovery again. Rotating `MCP_API_KEY` or
the Entra client secret requires a service restart but no data migration.

Render's current Docker and Blueprint documentation is authoritative for platform behavior:

- [Docker on Render](https://render.com/docs/docker)
- [Blueprint YAML reference](https://render.com/docs/blueprint-spec)
- [Render health checks](https://render.com/docs/health-checks)

## Azure Container Apps deployment

Use the same tested image; do not rebuild application code for Azure. The following settings are a
deployment checklist, not infrastructure automation:

1. Push the verified versioned image to an existing Azure Container Registry.
2. Create or update one Container App with external HTTPS ingress and target port `3000`.
3. Set `PORT=3000`, configure an HTTP liveness probe on `/health`, and configure an HTTP readiness
   probe on `/ready`, both on port `3000`.
4. Begin with one active revision, one minimum replica, and one maximum replica. Adjust scaling
   only after measuring request concurrency and Fabric throttling.
5. Enable a system-assigned managed identity. Set `AZURE_AUTH_MODE=default` and omit
   `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET`. For a user-assigned identity,
   set only its client ID when required by Azure Identity.
   Permit outbound TCP `1433` to Fabric Data Warehouse endpoints when Lakehouse/Warehouse schema
   inspection or table sampling is required.
6. Grant the identity only the required Fabric workspace roles and satisfy the Fabric and Power BI
   tenant settings for service principals and managed identities.
7. Store `MCP_API_KEY` as a Container Apps secret reference. Prefer an Azure Key Vault reference
   for production secrets.
8. Send stdout/stderr to Log Analytics. Alerts may include error codes and request IDs, but must not
   include access tokens, credentials, DAX rows, or full semantic-model definitions.
9. Deploy with `POWERBI_MCP_READONLY=true`, verify the probes and MCP read workflow, then explicitly
   approve any transition to write mode.

If managed identity cannot complete a required Fabric operation in the target tenant, keep the
application in read-only mode while diagnosing tenant policy. Do not silently fall back to a
client secret.

Microsoft's current Container Apps documentation is authoritative for the Azure configuration:

- [Ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)
- [Health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes)
- [Managed identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity)
- [Secret management](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)

## Post-deployment acceptance

For either platform, acceptance requires all of the following:

- `/health` and `/ready` return HTTP 200 without authentication and reveal only status.
- `/mcp` returns HTTP 401 without the bearer secret and initializes with the correct secret.
- The server advertises exactly 25 published tools and two static resources.
- Workspace discovery returns only workspaces visible to the Entra principal, and Fabric rejects
  requests beyond that principal's roles and item permissions.
- A process restart does not change behavior or require local state recovery.
- The approved disposable lifecycle completes and permanently deletes its model.
- Platform logs contain neither configured secrets nor returned DAX rows/model definitions.
- Lakehouse/Warehouse schema inspection succeeds when the principal has SQL access; bounded table
  sampling never accepts caller-provided SQL.

Semantic-model deletion is permanent. Always preview, repeat the exact model ID and current display
name, set the permanent-delete confirmation, and apply only against a disposable non-production
item.
