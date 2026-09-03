# ADR 0004: Preview-first Fabric lifecycle orchestration

- Status: Accepted
- Date: 2026-09-03

## Context

Fabric semantic-model creation, definition reads, and definition updates can return either an
immediate response or a `202 Accepted` long-running operation. Definition updates replace the
whole public definition, so an update based on stale state can overwrite another actor's work.
Fabric deletion can be recoverable or permanent, but Microsoft currently excludes semantic models
from the item types that support recovery. Connection binding accepts one source reference per
request.

The model engine validates a supported TMSL subset, applies an atomic change batch, and produces
stable semantic hashes and diffs. Lifecycle orchestration must connect that engine to Fabric
without weakening those guarantees.

## Decision

Use one stateless `SemanticModelService` as the orchestration boundary between callers, the model
engine, and `FabricClient`.

- Build and validate the complete TMSL definition before creation.
- Resolve Fabric long-running operations only within a configured polling budget. Return the
  operation ID when the budget expires instead of polling without a bound.
- Treat `percentComplete` as optional progress metadata because Fabric can return it as `null` for
  an in-progress operation; terminal state is determined from `status`.
- Fetch and parse the current definition before every model mutation.
- Require the caller's lowercase SHA-256 `expectedDefinitionHash` for definition updates. Reject a
  mismatch before calling the Fabric update endpoint.
- Preview mutation batches by default. An explicit `apply: true` is required for a live write.
- Preserve supported definition metadata and optional definition parts during read-modify-write.
- Emit definition-properties version `5.0` for new models, while accepting and preserving bounded
  numeric versions returned by Fabric after it normalizes a TMSL definition. The upstream JSON
  schema defines this field as a string and current Microsoft examples include different versions.
- Read the definition back after create and update, then verify both its semantic hash and object
  counts.
- Keep item property updates separate from definition updates.
- Treat semantic-model deletion as permanent and irreversible. Require the target ID to be repeated
  exactly, require the current display name as an exact case-sensitive confirmation, require
  `confirmPermanentDelete: true`, retain preview by default, and send `hardDelete=true` only after
  `apply: true`.
- Bind exactly one named data source per call. Read authoritative connection metadata by connection
  ID, derive the requested source's non-secret type/path, and reject mismatches before binding.
- Bound list and model-summary output with scoped continuation tokens and per-section limits.

The initial connection-detail resolver supports explicit `type`/`path` address metadata, TDS
server/database sources, and Web URL sources. Unsupported mappings fail closed. Adding a new
connector requires a tested, deterministic mapping rather than a best-effort guess.

## Consequences

- Concurrent definition changes are visible and must be reconciled instead of being silently
  overwritten.
- A timed-out synchronous request can safely return an operation handle for later status polling
  through MCP.
- Read-back mismatches surface as errors even when Fabric accepted a write.
- Semantic-model deletion is available but intentionally difficult to invoke accidentally because
  Fabric cannot recover this item type.
- The service may perform multiple safe reads around one non-retried write.
- Models outside the supported lossless TMSL subset remain rejected before mutation.
- Calculation-item annotations are not exposed by the typed subset because the live TMSL import
  contract rejects that property; annotations remain supported on model objects where TMSL accepts
  them.
- Calculation-group tables always emit and require their Analysis Services
  `calculationGroup`-source import partition, which is implementation metadata rather than a
  caller-managed table partition.
- Restore the documented relationship defaults (`many` to `one`, one-direction filtering) when
  Fabric omits those default-valued properties during definition readback.

## References

- [Create a semantic model](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/create-semantic-model)
- [Get a semantic model definition](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/get-semantic-model-definition)
- [Update a semantic model definition](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/update-semantic-model-definition)
- [Delete a semantic model](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/delete-semantic-model)
- [Fabric retention and supported recoverable item types](https://learn.microsoft.com/en-us/fabric/admin/retention-recovery#supported-item-types)
- [Bind a semantic model connection](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/bind-semantic-model-connection)
- [Get a Fabric connection](https://learn.microsoft.com/en-us/rest/api/fabric/core/connections/get-connection)
- [Fabric long-running operations](https://learn.microsoft.com/en-us/rest/api/fabric/articles/long-running-operation)
