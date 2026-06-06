# Demo runbook

End-to-end: an AI agent requires a real EUDIW age-verification before helping with an
age-restricted request.

## What you need

- Node 20+ and `pnpm`.
- A **public tunnel** to your machine (the wallet and your MCP client must reach the server). e.g.
  `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.
- An **EUDI wallet** with an age-capable credential:
  - PID (`eu.europa.ec.eudi.pid.1`) with `age_over_18`, or the Age Verification doc (`eu.europa.ec.av.1`).
  - Some deployments issue PID as **SD-JWT VC** instead of mso_mdoc → set the `pid` profile to
    `format: dc+sd-jwt` with the right `vct` (see `CREDENTIAL_PROFILES` below).

## 1. Install & build

```bash
pnpm install && pnpm build
```

## 2. Run the server (publicly reachable)

```bash
cd examples/server && cp .env.example .env
# edit .env: set PUBLIC_URL to your tunnel, and the credential registry for your wallet
```

`.env` for a deployment whose PID is **SD-JWT VC** rather than mso_mdoc:

```
PUBLIC_URL=https://<your-tunnel>
CREDENTIAL_PROFILES={"pid":{"format":"dc+sd-jwt","vct":"<the PID vct your wallet holds>"}}
```

Then from the repo root (config is read from `examples/server/.env`):

```bash
pnpm dev:server
# → MCP at https://<your-tunnel>/mcp
```

> The built-in defaults (`pid`, `av`, `mdl`, `photoid`) are mso_mdoc; override only what differs for
> your wallet. The `vct` is issuer-defined — set it to what your wallet actually holds.

## 3. Connect your MCP client

In your MCP client, **add a custom connector** → URL `https://<your-tunnel>/mcp`.
Leave the OAuth fields blank (the server runs an auto-approve OAuth so registration just works).
Confirm the `request_credential` tool appears.

> For booth reliability, also add a **Project instruction**: "Before assisting with anything
> age-restricted or ethically sensitive, call `request_credential` for `age_over_18` first, give me
> the link, poll `get_presentation_status`, and only continue once it's verified with age_over_18 true."

## 4. Run the demo

1. Ask your agent something age-restricted ("help me order a case of wine online").
2. The agent calls `request_credential` (for `age_over_18`) and gives you the link.
3. Open it on your phone → scan the QR with your EUDI wallet (or tap "Open in wallet").
4. Present `age_over_18`. The page flips to ✓ and the agent's `get_presentation_status` returns
   `verified` with `age_over_18: true` — it proceeds. If declined/under-18 → it refuses.

## Notes & extension points

- **Inline QR in chat (MCP Apps):** on by default (`INLINE_QR=true`) — the QR renders inside the
  conversation in a sandboxed iframe on hosts that support MCP Apps, with a
  text link fallback elsewhere. Set `INLINE_QR=false` for link-only.
- **Beyond age:** `request_credential` handles any use case — request other types (`pid`, `mdl`,
  `photoid`, …) and claims (name, birthdate, …), or multiple credentials at once; `request_presentation`
  takes raw DCQL.
- **DC API** (`navigator.credentials.get`) is not wired yet. The step-up page uses the QR
  (cross-device) and the `openid4vp://` deep link (same-device). Adding a DC API path needs the
  request delivered by value and verifier support for the DC-API response — a clean follow-up on the
  step-up page.
- **OAuth is auto-approve** (authenticates the agent, not a human). Add real consent via
  `createOAuth({ onAuthorize })` before exposing real data.
- The step-up page is a **throwaway demo UI** — replace it with your own; the core only returns the
  request URI + status.

## Troubleshooting

- Connector fails to add → the URL must be public HTTPS and `/mcp` reachable; check
  `curl https://<tunnel>/.well-known/oauth-protected-resource`.
- `request_credential` returns a link but the wallet won't match → check the `CREDENTIAL_PROFILES`
  entry for that type (mdoc vs SD-JWT `format`, and the exact `vct`/`doctype` your wallet holds).
- The agent won't call `request_credential` → start a fresh conversation (it caches the tool list), and
  add the Project instruction above.
