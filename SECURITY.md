# Security policy

`eudi-agent-mcp` is an early-stage, community-driven open-source project,
maintained on a best-effort basis. There are no production SLAs and no
dedicated security response team. If your deployment carries
production-grade risk, treat this code as a starting point and apply
your own review accordingly.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Two paths:

1. **GitHub's Private Security Advisory** (preferred): open one against
   this repository — "Security" tab → "Report a vulnerability". This
   keeps the report private to the maintainers and gives you a place
   to track the fix.
2. **Email** `ciso@verifiables.com` if you'd rather not go through
   GitHub. Include the same details: description, reproduction steps,
   and the commit / version you tested against.

We'll acknowledge and triage as we're able. There's no committed
response window; it depends on maintainer availability.

## What's in scope

Useful places for security research to focus — things the core
library and the widget actually own:

* **Purpose → DCQL translation** (`resolvePurpose`, `mergeProfiles`,
  and the internal `purposeToDcql` helper): claim path overrides,
  namespace handling, purpose-to-profile resolution. Bugs here could
  ask the wallet to disclose more claims than the agent's purpose
  requested. Structural validation of the resulting query is delegated
  to `dcql`; report shape-validation bugs to that project.
* **OAuth 2.1 layer** (`createOAuth`): bearer token handling,
  PKCE downgrade, DCR abuse, refresh token rotation.
* **MCP tool wiring** (`createIdentityMcpServer`): tool input
  schema, purpose validation, request_credential / request_presentation
  boundary handling.
* **Store implementations** shipped here (`MemoryStore`, the example
  server's `FileStore`): unauthenticated access, replay, persistence
  integrity.
* **MCP Apps widget** (`@verifiables/mcp-apps-widget`): sandbox
  escape, CSP bypass, structured-content rendering.

## What's out of scope

These belong to layers beside or below this project, not here:

* **OID4VP request construction** itself — request URI signing /
  encryption, `request_uri` handling, cross-origin request smuggling,
  client_id authentication. That's the `Oid4vpVerifier` adapter's
  concern, owned by whoever ships the adapter (the EUDI reference
  one in `examples/server/src/verifier-eudi.ts` for the demo, a
  commercial verifier, or your own private one).
* **Credential / issuer trust list correctness** — the wallet's
  job.
* **Wallet UX or device-side selective disclosure** — the wallet's
  job.
* **Cryptographic primitives of the underlying VP / VC formats** —
  the spec libraries' job.
* **Default-permissive OAuth** (`onAuthorize` not overridden),
  hardcoded test defaults, etc. — documented demo behaviours by
  design. Override them before going to production; don't report
  them as vulnerabilities.
