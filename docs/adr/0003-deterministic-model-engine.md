# ADR 0003: Deterministic and loss-aware model mutation engine

- Status: Accepted
- Date: 2026-09-02

## Context

Fabric's update-definition operation replaces a semantic-model definition. A model mutation must
therefore preserve every supported object, detect stale state through a stable hash, and fail before
submission when one operation would leave the model invalid. The Python reference supplies useful
DAX lint, identifier quoting, dependency-analysis, and atomic-edit behavior, but its Desktop/TOM and
TMDL implementation cannot be used directly by this cloud-only TypeScript service.

Fabric documents `model.bim` and `definition.pbism` as the required parts for a TMSL semantic-model
definition. TMSL replacement semantics also mean that omitted child collections are deleted. This
makes silent acceptance and removal of unknown fields unsafe.

## Decision

Phase 3 introduces one strict `ModelSpec`, a loss-aware TMSL codec, and one atomic transaction engine.
All changes are applied to an isolated normalized copy. The copy is semantically validated after the
entire batch, then returned with before/after SHA-256 hashes and a semantic diff. The caller's model
is never mutated, including when a duplicate, missing parent, dependency conflict, invalid reference,
or final validation error aborts the batch.

The supported definition subset is deliberately small:

- structured data-source metadata without credentials;
- source and calculated columns;
- M, query, entity/Direct Lake, and calculated partitions;
- measures, single-column relationships, hierarchies, calculation groups and items;
- named M expressions and read-only roles with table filters.

Collections with set semantics are normalized by case-insensitive name. Hierarchy-level and
calculation-item order is preserved. DAX and M line endings are normalized to LF. Object keys are
canonicalized before hashing and serialization.

The codec preserves Fabric annotations, lineage tags, common column metadata, and optional
definition parts such as `diagramLayout.json`. It rejects TMDL/TMSL mixing, unsafe part paths,
malformed base64, invalid JSON, and other extra TMSL fields that do not yet have a lossless
`ModelSpec` mapping. TMSL `singleColumn` relationships are the only relationship shape supported;
composite relationship payloads are rejected. Expanding the subset requires schema, codec,
round-trip, diff, and rollback tests in the same change.

DAX lint findings carry an explicit `blocking` flag and are advisory. The local known-function
catalog is deliberately partial because Microsoft adds built-in functions and supports user-defined
functions. `DL008` therefore means only that a call is absent from the local catalog; it is always
informational and non-blocking. Static reference extraction validates common table, column, measure,
calculation-group, and RLS references and enables dependency reporting, but it is not presented as a
complete DAX compiler. Executable DAX validation against Fabric remains authoritative and belongs to
a later phase.

## Consequences

- Model operations are deterministic and independently testable without Fabric credentials.
- Unsupported definitions fail closed rather than suffering a lossy full-definition rewrite.
- Existing tenant models containing unsupported objects such as perspectives, cultures, functions,
  or translations are not yet eligible for mutation.
- Phase 4 can compose fetch, hash check, preview, apply, read-back, and verification around one engine.
- Phase 3 performs no live Fabric writes and leaves every MCP handler unchanged.

## References

- [Fabric semantic-model definition](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/semantic-model-definition)
- [TMSL reference](https://learn.microsoft.com/en-us/analysis-services/tmsl/tabular-model-scripting-language-tmsl-reference)
- [TMSL model replacement semantics](https://learn.microsoft.com/en-us/analysis-services/tmsl/model-object-tmsl)
- [TMSL relationship object](https://learn.microsoft.com/en-us/analysis-services/tmsl/relationships-object-tmsl)
- [Python reference agent guidance](../../powerbi-mcp/AGENTS.md)
