# eudi-agent-mcp

Let AI agents request **EUDIW / OID4VP credential presentations** — age verification and
more — through the **Model Context Protocol (MCP)**.

An MCP client connects and gets a `request_credential` tool. When the user's request
needs verified attributes — proving they're over 18 for something age-restricted, or sharing a real
name/birthdate/mDL — the agent calls `request_credential`, hands the user a link/QR, they present the
credential from their **EUDI wallet**, and the agent only proceeds once it's cryptographically
`verified`. Selective disclosure means only the requested claims are shared (e.g. just `age_over_18`,
not the birth date).

It is **verifier-agnostic**: the agent-facing tools talk to a small `Oid4vpVerifier` interface, so
you can plug in any OID4VP backend. A ready adapter for the **EUDI reference verifier** is included.

```
┌────────────┐    MCP tools     ┌──────────────────┐   Oid4vpVerifier   ┌────────────────────┐
│ MCP client │ ───────────────▶ │  this MCP server │ ─────────────────▶ │  OID4VP verifier   │
│  / agent   │ request_credential│  (@.../core)     │  createRequest/    │  (EUDI ref / your  │
└────────────┘                  └──────────────────┘  getResult         │  own / a library)  │
                                       │ link/QR                         └─────────┬──────────┘
                                       ▼                                           │ OID4VP
                                ┌───────────┐         present claims               ▼
                                │ EUDI wallet│ ◀───────────────────────────  (QR / deep link)
                                └───────────┘
```

## Packages

| Package | What it is |
| --- | --- |
| `@verifiables/eudi-mcp-core` | Framework-neutral library: the `Oid4vpVerifier` interface, agent-facing MCP tools (`request_credential`, `request_presentation`, `get_presentation_status`), a credential-profile registry, a pluggable OAuth 2.1 layer, an SD-JWT VC claim decoder, and `createIdentityMcpServer()`. |
| `@verifiables/mcp-apps-widget` | Self-contained **MCP Apps** (SEP-1865) widget HTML that renders the QR **inline in the chat** (sandboxed iframe). Built with esbuild. |

The verifier is **bring-your-own**: pick (or write) an `Oid4vpVerifier` adapter for whatever
backend you actually run. A 115-line reference adapter against the EUDI sandbox
(`verifier-backend.eudiw.dev`) lives in `examples/server/src/verifier-eudi.ts` so the demo works
out of the box; it isn't published to npm because tracking a third-party endpoint's API isn't
something this project wants to own. Use it as a template, then swap to your own (in-process via
`@openid4vc/openid4vp`, a commercial verifier, or a private one).

| Location | What it is |
| --- | --- |
| `examples/server` | Reference Express deployment: MCP over Streamable-HTTP + OAuth + an EUDI-sandbox `Oid4vpVerifier` adapter + a throwaway QR/poll page. Clone-and-run. |

## The integration seam

Everything is wired to one interface:

```ts
interface Oid4vpVerifier {
  createRequest(query: PresentationQuery): Promise<{ id: string; uri: string }>
  getResult(id: string): Promise<{ status: 'pending'|'verified'|'failed'|'expired'; claims?: Record<string, unknown> }>
}
```

Implement it for your backend (EUDI ref verifier ✅ included; an in-process `@openid4vc` library or a
commercial verifier are just another adapter) and the tools work unchanged.

## Tools & registered purposes

- **`request_credential`** — the primary tool, strictly purpose-driven. The agent passes a
  **registered purpose** and the server resolves the credential type, format, and claim list
  itself. No `type`, no `format`, no `claims` are accepted from the agent here — those are
  deployment decisions the LLM is bad at and shouldn't be invited to make.

  ```jsonc
  // The agent's full call:
  request_credential({ purpose: "age_gate" })
  ```

- **`request_presentation`** — the escape hatch when no registered purpose fits: raw DCQL.
- **`get_presentation_status`** — long-poll for the disclosed claims (default 45 s wait, cap 55 s);
  for age gating, check `age_over_18: true`.

The deployment registers **purposes** (`name` → `claims` + preferred `types`) and **credential
profiles** (`type` → doctype / vct / format). The agent doesn't need to know about DCQL, mso_mdoc vs
SD-JWT, namespaces, or specific doctypes — that's the server's job:

```ts
createIdentityMcpServer({
  verifier, store, baseUrl,
  credentialProfiles: {
    pid: { doctype: 'eu.europa.ec.eudi.pid.1', vct: 'urn:eudi:pid:1', format: 'dc+sd-jwt' },
    av:  { doctype: 'eu.europa.ec.av.1', format: 'mso_mdoc' },
  },
  purposes: {
    age_gate: {
      claims: ['age_over_18'],
      types: ['av', 'pid'],
      description: 'Gate age-restricted retail (alcohol, tobacco, vapes, …) or any over-18 content.',
    },
    basic_identity: {
      claims: ['given_name', 'family_name'],
      types: ['pid'],
      description: 'Verified first + last name from the EU PID. Form fill, account creation.',
    },
    kyc_basic: {
      claims: ['given_name', 'family_name', 'birth_date', 'nationality'],
      types: ['pid'],
      description: 'Identity at financial / employment onboarding.',
    },
  },
})
```

When the agent calls `request_credential({ purpose: 'age_gate' })`, the server scans the preferred
types in order, picks the first one that's actually in `credentialProfiles` (`av` here), and
generates the matching OID4VP request. Operators can change which credential serves each purpose by
editing config; the agent's tool call stays the same.

The `description` field flows straight into the LLM-facing instructions block (server-side, no
extra wiring): the host shows the model a list of registered purposes plus their descriptions, so
the agent picks the right one for the task without you having to write retail-flavoured copy into
the system prompt. If you need full control over the instructions (compliance review, custom
domain copy), pass `instructions: '…'` directly; the auto-derived block is then skipped.

## Inline QR in the chat (MCP Apps)

When `appUi` is set, the presentation tools render the QR **inline in the conversation** via
**MCP Apps** (SEP-1865): the tool declares a UI resource (`text/html;profile=mcp-app`), the host
renders it in a sandboxed iframe, and the QR (server-rendered SVG) is delivered via the tool result's
`structuredContent`. The widget is fully self-contained (App runtime + SVG inlined — the sandbox CSP
blocks external scripts).

```ts
import { WIDGET_HTML } from '@verifiables/mcp-apps-widget'
createIdentityMcpServer({ verifier, store, baseUrl, appUi: { resourceHtml: WIDGET_HTML } })
```

A **plain-text link fallback** is always included, so hosts without MCP Apps support degrade
gracefully. Supported by a growing set of MCP hosts; mobile support and some
render/handshake behaviors are still settling — test on the surfaces your users will use.

## Quickstart

```bash
pnpm install
pnpm build
cp examples/server/.env.example examples/server/.env   # optional
pnpm dev:server                                          # http://localhost:3000/mcp
```

The server needs to be **publicly reachable** for a real demo (the wallet fetches the request and
the agent's link must open on the user's phone). Use a tunnel and set `PUBLIC_URL`:

```bash
PUBLIC_URL=https://<your-tunnel> pnpm dev:server
```

### Connect your MCP client

Add a **custom connector** pointing at `https://<your-host>/mcp`. The server ships a minimal
**auto-approve OAuth 2.1** layer (RFC 9728 / 8414 / 7591 + PKCE), which most MCP client connectors
requires, so registration succeeds with no manual client setup.

> The OAuth layer authenticates the *agent*, not a human — it auto-approves by default. The human is
> verified by the wallet presentation. **Before exposing real user data, add a real consent/login**
> via `createOAuth({ onAuthorize })`.

### Use it

Ask the agent to help with something age-restricted. It calls `request_credential` for `age_over_18`,
gives you a link/QR, you present the credential from your EUDI wallet, and it proceeds only once
`verified`. (Same flow for any other claim — name, mDL, etc.)

## Programmatic use

```ts
import { createIdentityMcpServer, MemoryStore, type Oid4vpVerifier } from '@verifiables/eudi-mcp-core'

// Bring your own Oid4vpVerifier adapter. The reference impl against the EUDI
// sandbox lives in examples/server/src/verifier-eudi.ts (115 LOC, copy it as
// a starting point) — there is no published verifier package. Production
// adapters usually wrap @openid4vc/openid4vp, a commercial verifier, or your
// own internal one.
declare const verifier: Oid4vpVerifier

const server = createIdentityMcpServer({
  verifier,
  store: new MemoryStore(),
  baseUrl: 'https://your-host',
})
// connect `server` to any MCP transport (Streamable-HTTP, stdio, ...)
```

## Status

Early / hackathon stage. The EUDI adapter targets the public reference verifier
(`verifier-backend.eudiw.dev`, OpenID4VP 1.0, DCQL) and handles both **mso_mdoc** (decoded via the
verifier's utility endpoint) and **SD-JWT VC** (`dc+sd-jwt`, decoded locally) presentations — point
each `credentialProfiles` entry at your wallet's `doctype`/`vct`/`format` (some PID deployments are SD-JWT
VC). Additional verifier adapters (in-process `@openid4vc`, commercial verifiers) are just more
`Oid4vpVerifier` implementations.

## License

Apache-2.0.
