# Release-candidate test evidence

## Candidate

- Version: `0.1.0-rc.1`
- Verification date: 2026-09-03
- Runtime: Node.js 24.14.0
- Release deployment: not performed; Phase 6 prepares the candidate for Render testing

## Tenant-independent gates

The required local command is `npm run check`. It covers formatting, lint rules, strict TypeScript
types, unit tests, MCP contract tests, mocked Microsoft HTTP integration tests, real MCP-client
end-to-end tests, coverage thresholds, and the production TypeScript build.

| Risk or behavior                      | Automated evidence                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Timeout and abort                     | `tests/integration/http-client.test.ts`                                                |
| Safe retry and API throttling         | `tests/integration/http-client.test.ts`, `tests/integration/fabric-client.test.ts`     |
| Fabric 202 operation resumption       | `tests/unit/semantic-model-service.test.ts`, `tests/unit/mcp-workflow-service.test.ts` |
| Malformed MCP/HTTP input              | `tests/integration/http.test.ts`, `tests/e2e/mcp.test.ts`                              |
| Missing or invalid bearer credential  | `tests/integration/http.test.ts`                                                       |
| Host and Origin rejection             | `tests/integration/http.test.ts`                                                       |
| Workspace allowlist                   | Fabric/Power BI client integration tests                                               |
| Concurrent semantic hash conflict     | model-engine, lifecycle-service, and live Phase 6 tests                                |
| Fabric and Power BI failure responses | client integration and workflow unit tests                                             |
| Read-only enforcement                 | `tests/unit/mcp-workflow-service.test.ts` and lifecycle/client tests                   |
| Secret and response redaction         | logging, MCP server, and real MCP-client tests                                         |
| Bounded DAX rows and response bytes   | `tests/unit/mcp-workflow-service.test.ts`                                              |
| Permanent-delete confirmation         | lifecycle-service, contract, and end-to-end tests                                      |

The separate `npm run test:container` release gate builds and starts the production image. It
checks exact Node version, a non-root UID, no development-only dependencies, read-only filesystem
compatibility, no Linux capabilities, `/health`, `/ready`, bearer rejection, authenticated MCP
discovery, restart recovery, secret-free logs, and a zero-exit SIGTERM shutdown.

## Live Fabric gates

The opt-in command `npm run test:live:phase6` refuses to run unless write mode, live mutation, live
permanent deletion, and exactly one allowlisted development workspace are explicit. It executes
the following complete workflow twice through an actual MCP HTTP client:

1. Initialize MCP and verify the 18-tool contract.
2. List workspaces and confirm the allowlisted development workspace is visible.
3. Preview and create a uniquely named, self-contained import semantic model.
4. List and get the created item; update and read back its name and description.
5. Read its definition and deterministic snapshot hash.
6. Create, update, and delete a representative DAX measure and hierarchy.
7. Submit a stale hash and verify `STALE_DEFINITION_HASH` without mutation.
8. Verify the delete batch restores the original definition hash.
9. Read bounded model information, compare the deployed model, and pass every pre-deploy check.
10. Preview a full refresh, start it, poll to a successful terminal state, and retain no local
    operation state.
11. Validate correct DAX, reject invalid DAX, and execute a one-row bounded DAX query.
12. Permanently delete the exact disposable model with repeated ID, exact current name, and strong
    confirmation; list models and verify it is absent.

The test model uses an inline `#table` M partition, so connection binding is not applicable. Binding
serialization, preview/apply behavior, allowlisting, failure mapping, and read-only enforcement are
covered by tenant-independent tests.

## Recorded result

Results from the release-candidate tree on 2026-09-03:

- `npm run check`: passed; 21 test files and 182 tests passed, 94.72% line coverage, production
  build passed
- `npm run test:container`: passed; Node `v24.14.0`, UID `1000`, 18 tools, two resources, restart
  and graceful shutdown verified
- Phase 6 live run 1: passed every operation above; permanent delete verified
- Phase 6 live run 2: passed every operation above from a new model; permanent delete verified
- Post-delete active artifacts: none from either completed run
- Official MCP Inspector strict `tools/list`: passed with 18 tools and no portability error
- GitHub Actions quality gate: pending candidate commit
- GitHub Actions production container gate: pending candidate commit

The pre-candidate runs found and resolved two verifier issues and one product boundary defect: Docker
Desktop can reassign an automatically published host port after restart, a complete Fabric
update-and-readback can exceed the MCP client's default request timeout, and `list_semantic_models`
was forwarding `workspaceId` into a pagination-only parser. The final container and live runs used
the corrected code. Every preliminary disposable model was also permanently deleted during
`finally` cleanup.

No critical-path test may be silently skipped. A failed cleanup leaves the candidate blocked and the
created model ID must be resolved before any release tag is created.
