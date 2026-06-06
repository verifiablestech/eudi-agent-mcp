# Contributing to eudi-agent-mcp

Thanks for your interest. This project is small and opinionated, but pull
requests are welcome.

## Ground rules

* **Apache-2.0 only.** All contributions must be licensed under Apache-2.0.
  By opening a PR you certify you have the right to do so and agree to the
  [Developer Certificate of Origin](https://developercertificate.org).
* **Sign your commits.** Add a `Signed-off-by:` trailer to every commit
  (`git commit -s`). PRs without DCO sign-off won't be merged.
* **One topic per PR.** Smaller PRs land faster. Refactors and behaviour
  changes go in separate commits.

## What we welcome

* New `Oid4vpVerifier` adapters (commercial verifiers, additional public
  reference implementations, in-process libraries).
* Additional `Store` adapters (Redis, Postgres, DynamoDB, …) — keep the
  interface minimal.
* MCP host compatibility fixes when
  a real-world host trips a transport edge.
* Documentation: integration guides, troubleshooting, deployment recipes.

## What's out of scope

* Identity / wallet / issuer logic. This project is a thin layer between
  agents and OID4VP verifiers; the heavy lifting belongs in the verifier
  or the wallet itself.
* Bundled UIs beyond the MCP Apps QR widget.
* Tools that re-introduce stateful delegation. Stateless, per-request
  verification is the design choice; long-lived scoped grants belong in
  a different layer.

## Local setup

```bash
pnpm install
pnpm build
pnpm test
```

Reference server: `pnpm dev:server` (Express, MCP over Streamable-HTTP +
OAuth, public URL via `PUBLIC_URL`).

## Releases

Versioning follows semver. Breaking changes bump the major; feature
additions bump the minor. The reference server is exempt; treat the
`@verifiables/eudi-mcp-*` packages as the stable API.
