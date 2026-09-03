# ADR 0007: Client-neutral MCP authorization

- Status: Accepted
- Date: 2026-09-03

## Context

The remote `/mcp` endpoint must work with standards-compliant MCP hosts rather than depending on a
single vendor's connector behavior. A static bearer secret can protect a controlled integration,
but it does not provide OAuth discovery, per-user authorization, token audience binding, or broadly
interoperable client onboarding. The server must also remain deployable behind different public
origins without embedding a Render, Azure, or custom-domain hostname in the application.

MCP client authorization and the server's outbound Microsoft identity solve different problems.
Changing client authentication must not alter Fabric, Power BI, SQL, semantic-model, or safety
behavior.

## Decision

Keep Streamable HTTP at `/mcp` and add a production OAuth resource-server mode. Publish RFC 9728
protected-resource metadata at the root and path-specific discovery locations. Unauthenticated
responses advertise the path-specific metadata URL and required scopes in `WWW-Authenticate`.

Validate JWT access tokens against a configured remote JWKS with an explicit algorithm allowlist,
issuer, audience, expiration, and required scopes. Accept `scope` and `scp` claims. The external
authorization server remains responsible for authorization-code flow, S256 PKCE, consent, client
registration, and token issuance.

Derive the canonical MCP resource and discovery URLs from `MCP_PUBLIC_BASE_URL`. Require an HTTPS
origin in production and permit loopback HTTP only outside production. Add that configured hostname
to request host validation. Retain API-key mode for local and controlled private integrations.

## Consequences

- The application image contains no deployment hostname and moves between hosts by configuration.
- Standards-compliant MCP clients can discover the authorization server and required scopes.
- Authorization-server selection and client-registration compatibility remain deployment concerns;
  the MCP resource server does not implement or proxy an identity provider.
- Existing core tools and Microsoft authentication are unchanged.
- API-key mode remains backward compatible, but it is not the recommended public deployment mode.
