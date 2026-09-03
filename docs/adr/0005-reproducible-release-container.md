# ADR 0005: Reproducible release container

- Status: Accepted
- Date: 2026-09-03

## Context

The first release must run unchanged on Render and Azure Container Apps, remain stateless across
restarts, expose platform health probes, and avoid shipping compilers, test tooling, or credentials.
The server already uses Node.js 24.14.0 and requires no local database or model-definition files.

## Decision

Build one multi-stage Debian-slim image from `node:24.14.0-bookworm-slim`. Install dependencies from
the committed npm lockfile, compile TypeScript in the build stage, prune development dependencies,
and copy only the runtime package metadata, production modules, and `dist` output into the final
stage. Run `node dist/index.js` directly as the image-provided unprivileged `node` user.

Keep all configuration at runtime. The image provides a Docker health check for `/health`; hosted
platforms configure `/health` for liveness and `/ready` for readiness. Render consumes the minimal
root Blueprint. Azure Container Apps consumes the same image and should use managed identity plus
secret references.

Add a CI container gate that builds the final image and verifies non-root execution, a read-only
filesystem, production-only dependencies, HTTP/MCP behavior, restart recovery, redacted logs, and
graceful SIGTERM shutdown.

## Consequences

- Render and Azure test the same application artifact and startup command.
- No workspace data, model state, or credential persists in the container filesystem.
- Image construction is simple and lockfile-based, but rebuilding the exact-version base tag can
  include upstream Debian security refreshes. Release evidence records the application version and
  CI result rather than claiming byte-identical image layers.
- The production image retains npm because the official slim Node image is used as the runtime
  base. Development packages and source/test files are not present.
- Write mode remains an explicit runtime decision and the supplied Render Blueprint starts in
  read-only mode.
