# ADR 0002: Azure Identity and safe HTTP policy

- Status: Accepted
- Date: 2026-09-02

## Context

The same server must authenticate from local development, Render, and Azure Container Apps. Fabric
REST and Power BI REST use different token audiences. Several Fabric APIs can return long-running
operations, and both services can throttle requests. Semantic-model writes cannot be blindly
replayed because a transport failure does not prove that the service rejected the first request.

## Decision

Use Azure Identity behind one credential interface. Select `ClientSecretCredential` for local and
Render service-principal deployments and `DefaultAzureCredential` for Azure managed identity or
developer credentials. Cache Fabric and Power BI access tokens independently and refresh them
before expiry.

Use one bounded HTTP helper for both API clients. It applies per-attempt timeouts, response-size
limits, typed error translation, request-ID preservation, secret-safe logging, and bounded
pagination. Automatic retries are permitted only for GET requests and explicitly marked read-only
POST requests such as DAX execution and definition retrieval. Create, update, delete, bind, and
refresh requests are never retried automatically. `Retry-After` is honored for safe throttled
requests, with a bounded delay.

Workspace identifiers are validated locally, while Entra roles and Fabric item permissions remain
the authorization boundary. Mutations also pass a read-only policy guard, which remains enabled by
default.

## Consequences

- Calling code does not change when deployment authentication moves from a Render client secret to
  Azure managed identity.
- A token for one Microsoft resource is never reused for the other resource.
- Request correlation survives error translation without exposing bearer tokens or credential
  values.
- Callers receive an explicit accepted-operation result for Fabric `202` responses and decide when
  to poll the long-running-operation endpoints.
- Retrying a mutation after an ambiguous failure remains a higher-level reconciliation decision,
  not transport behavior.
