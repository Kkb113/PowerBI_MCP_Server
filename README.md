# Fabric Semantic Model MCP Server

A remote Model Context Protocol server for managing Microsoft Fabric semantic models. The
project is implemented in strict TypeScript and follows the six-phase plan in
[`implementation.md`](./implementation.md).

## Current status

Phase 1 provides the production-shaped transport and frozen MCP contract. It does not call
Microsoft Fabric and cannot mutate a semantic model yet. All 18 Fabric-facing tools return a
structured `NOT_IMPLEMENTED` result until their phase is implemented.

Available now:

- Stateless Streamable HTTP at `POST /mcp`.
- Public, minimal `GET /health` and `GET /ready` probes.
- Constant-time bearer-token verification for `/mcp`.
- Host and browser-origin allowlists.
- Frozen tool input/output schemas and safety annotations.
- Static capability and safety resources.
- Structured logs with recursive secret redaction.
- Unit, contract, integration, and real MCP-client end-to-end tests.

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

Replace `MCP_API_KEY` in `.env` with at least 32 random characters. This project does not load
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

That test starts the HTTP service on an ephemeral port and uses the official MCP TypeScript client
to initialize, list tools, list and read resources, and call a placeholder tool through bearer
authentication.

## Configuration

| Variable                   | Required | Default         | Description                                |
| -------------------------- | -------: | --------------- | ------------------------------------------ |
| `MCP_API_KEY`              |      Yes | None            | Bearer secret with at least 32 characters. |
| `NODE_ENV`                 |       No | `development`   | `development`, `test`, or `production`.    |
| `HOST`                     |       No | `0.0.0.0`       | HTTP bind host.                            |
| `PORT`                     |       No | `3000`          | HTTP port.                                 |
| `MCP_ALLOWED_HOSTS`        |       No | Local hostnames | Host-header allowlist.                     |
| `MCP_ALLOWED_ORIGINS`      |       No | Host allowlist  | Browser Origin-hostname allowlist.         |
| `RENDER_EXTERNAL_HOSTNAME` |       No | None            | Render hostname appended to allowed hosts. |
| `LOG_LEVEL`                |       No | `info`          | `debug`, `info`, `warn`, or `error`.       |

Configuration is validated before the server binds a port. Error messages name invalid variables
but never include their values.

## Frozen Phase 1 contract

The MCP surface is defined once in `src/mcp/registry.ts`, and a parity test prevents the advertised
tools, safety classification, schemas, and write-tool set from drifting. The common tool result is:

```json
{
  "ok": false,
  "status": "not_implemented",
  "message": "...",
  "data": null,
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "...",
    "retryable": false
  }
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
- Phase 1 contains no Fabric or Power BI client and therefore no Fabric mutation path.

Bearer authentication is the initial Render test boundary. Microsoft Entra protection is planned
for the later Azure deployment phase.

## Behavioral reference

The Python behavioral reference is
[`sulaiman013/powerbi-mcp`](https://github.com/sulaiman013/powerbi-mcp) at commit
`977b4d126fed9dee7b8d6dade6d45dc5ac7064fb`. It is retained locally under the ignored
`powerbi-mcp/` directory and is not bundled with this TypeScript service.
