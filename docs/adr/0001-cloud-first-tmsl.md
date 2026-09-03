# ADR 0001: Cloud-first semantic models with TMSL

- Status: Accepted
- Date: 2026-09-02

## Context

The server must create, inspect, update, query, refresh, and safely delete Microsoft Fabric semantic
models from a remote Linux container. Desktop and local authoring paths are not available in Render
or Azure Container Apps. Fabric accepts semantic-model definitions in TMSL or TMDL formats.

## Decision

The service supports Fabric cloud semantic models only. It uses Fabric and Power BI HTTP APIs
and treats the TMSL `model.bim` JSON representation as its canonical definition. It does not add a
.NET sidecar, XMLA, TOM, ADOMD, Power BI Desktop discovery, PBIX extraction, or a TMDL parser.

The MCP server remains one stateless TypeScript process. Model changes will use a shared
fetch-normalize-hash-mutate-validate-diff-submit-read-back pipeline. Full-definition writes will
require the expected definition hash, and destructive operations will preview by default.

## Consequences

- The server can run unchanged as a Linux container on Render and Azure.
- JSON parsing, validation, stable serialization, hashing, and semantic diffing remain native to
  TypeScript.
- The remote MCP boundary can be tested without Microsoft credentials or Fabric mutation.
- Existing TMDL-authored models are not promised to round-trip losslessly until a live conversion
  test proves that Fabric can return and accept their TMSL representation.
- Desktop-only and XMLA-only capabilities remain explicitly out of scope unless an HTTP API
  limitation is demonstrated by the target lifecycle tests.
