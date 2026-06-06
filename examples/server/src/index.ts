import 'dotenv/config'
import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  MemoryStore,
  createOAuth,
  createIdentityMcpServer,
  resolveStatus,
  type CredentialProfile,
  type Oid4vpVerifier,
  type PurposeConfig,
  type VerificationDeps,
} from '@verifiables/eudi-mcp-core'
import { createEudiVerifier } from './verifier-eudi.js'
import { WIDGET_HTML } from '@verifiables/mcp-apps-widget'
import { renderStepUpPage } from './page.js'
import { FileStore } from './file-store.js'

const PORT = Number(process.env.PORT ?? 3000)
// Public base URL (must be the externally reachable one — used in OAuth metadata,
// step-up links and the QR). For a tunnel/deploy set PUBLIC_URL.
const BASE_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '')

// Parse an optional positive-int env var; `undefined` falls through to the
// library default so we never have to mirror those defaults here.
const intEnv = (name: string): number | undefined => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer; got ${raw}`)
  return n
}

const oauthTtls = {
  code: intEnv('OAUTH_CODE_TTL'),
  access: intEnv('OAUTH_ACCESS_TTL'),
  refresh: intEnv('OAUTH_REFRESH_TTL'),
}
const verificationRecordTtl = intEnv('VERIFICATION_RECORD_TTL')
const longPoll = {
  defaultSeconds: intEnv('LONG_POLL_DEFAULT_SECONDS'),
  maxSeconds: intEnv('LONG_POLL_MAX_SECONDS'),
  pollIntervalMs: intEnv('LONG_POLL_INTERVAL_MS'),
}

// Persist OAuth state (client registration + tokens) across restarts so MCP clients stay connected.
// Set STORE_PATH to a writable file; defaults to in-memory (lost on restart).
const store = process.env.STORE_PATH ? new FileStore(process.env.STORE_PATH) : new MemoryStore()
const oauth = createOAuth({ store, baseUrl: BASE_URL, ttls: oauthTtls })

let verifier: Oid4vpVerifier = createEudiVerifier({
  baseUrl: process.env.EUDI_VERIFIER_URL ?? 'https://verifier-backend.eudiw.dev',
})
// Optional local override: drop a (gitignored) `src/verifier.local.ts` exporting
// `createVerifier(defaultVerifier) => Oid4vpVerifier` to swap in your own OID4VP backend
// (e.g. behind a fallback). Absent in the repo, so the default stays the EUDI verifier.
try {
  const localOverride = './verifier.local.js'
  const mod = (await import(localOverride)) as {
    createVerifier?: (fallback: Oid4vpVerifier) => Oid4vpVerifier
  }
  if (mod.createVerifier) verifier = mod.createVerifier(verifier)
} catch {
  // no local override present
}
const deps: VerificationDeps = {
  verifier,
  store,
  baseUrl: BASE_URL,
  ...(verificationRecordTtl !== undefined ? { recordTtl: verificationRecordTtl } : {}),
}

// Optional per-deployment credential registry override (JSON), merged onto the
// built-in defaults inside the core server.
const credentialProfiles: Record<string, CredentialProfile> | undefined = process.env
  .CREDENTIAL_PROFILES
  ? (JSON.parse(process.env.CREDENTIAL_PROFILES) as Record<string, CredentialProfile>)
  : undefined

/**
 * Registered purposes the agent can call by name. Without these the LLM
 * has nothing to ask for — request_credential is purpose-only by design,
 * so an empty registry leaves only request_presentation (raw DCQL).
 * Override the defaults via the PURPOSES env (single-line JSON, same
 * shape as the defaults below).
 */
const defaultPurposes: Record<string, PurposeConfig> = {
  age_gate: {
    claims: ['age_over_18'],
    types: ['av', 'pid'],
    description:
      'Gate age-restricted content or actions (alcohol, tobacco, vapes, gambling, adult content, weapons, fireworks) or anything that requires an over-18 user.',
  },
  basic_identity: {
    claims: ['given_name', 'family_name'],
    types: ['pid'],
    description: 'Verified first and last name from the EU PID. Form fill, account creation.',
  },
  kyc_basic: {
    claims: ['given_name', 'family_name', 'birth_date', 'nationality'],
    types: ['pid'],
    description: 'Identity at financial / employment onboarding.',
  },
}
const purposes: Record<string, PurposeConfig> = process.env.PURPOSES
  ? (JSON.parse(process.env.PURPOSES) as Record<string, PurposeConfig>)
  : defaultPurposes

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// ── OAuth discovery metadata ──
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) =>
  res.json(oauth.protectedResourceMetadata())
)
app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (_req, res) =>
  res.json(oauth.authorizationServerMetadata())
)

// ── OAuth endpoints (auto-approve; add a real consent in createOAuth.onAuthorize) ──
app.post('/oauth/register', async (req, res) => {
  const c = await oauth.registerClient(req.body ?? {})
  res.status(201).json({
    client_id: c.client_id,
    redirect_uris: c.redirect_uris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  })
})
app.get('/oauth/authorize', async (req, res) => {
  const q = req.query as Record<string, string>
  const r = await oauth.authorize({
    client_id: q.client_id,
    redirect_uri: q.redirect_uri,
    code_challenge: q.code_challenge,
    code_challenge_method: q.code_challenge_method,
    state: q.state,
    scope: q.scope,
    resource: q.resource,
  })
  if ('redirect' in r) return res.redirect(r.redirect)
  return res.status(r.status).json({ error: r.error })
})
app.post('/oauth/token', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const r = await oauth.token(req.body ?? {})
  if ('error' in r && 'status' in r) return res.status(r.status).json({ error: r.error })
  return res.json(r)
})

// ── MCP endpoint (Streamable-HTTP, bearer-gated) ──
async function handleMcp(req: express.Request, res: express.Response) {
  const auth = req.header('authorization')
  const token = auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : undefined
  if (!(await oauth.validateAccessToken(token))) {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${oauth.protectedResourceMetadataUrl()}"`)
    return res.status(401).json({ error: 'unauthorized' })
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  const server = createIdentityMcpServer({
    verifier,
    store,
    baseUrl: BASE_URL,
    // Deployment credential registry (how to request each type from the wallet).
    // Override defaults via CREDENTIAL_PROFILES, e.g. for a SD-JWT VC PID:
    //   CREDENTIAL_PROFILES={"pid":{"format":"dc+sd-jwt","vct":"urn:eudi:pid:1"}}
    ...(credentialProfiles ? { credentialProfiles } : {}),
    // Registered purposes the agent calls by name (age_gate, basic_identity,
    // kyc_basic). The whole point of the purpose path is that the LLM never
    // picks credential types or formats; it just names what the request is for.
    purposes,
    // Inline QR in the chat via MCP Apps (set INLINE_QR=false to disable).
    ...(process.env.INLINE_QR === 'false' ? {} : { appUi: { resourceHtml: WIDGET_HTML } }),
    // Tuning knobs — each one falls through to the library default when unset.
    ...(verificationRecordTtl !== undefined ? { verificationRecordTtl } : {}),
    longPoll,
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
}
app.post('/mcp', handleMcp)
app.get('/mcp', handleMcp)

// ── Step-up page + status (the throwaway demo UI) ──
app.get('/present/:id', async (req, res) => {
  const r = await resolveStatus(deps, req.params.id)
  res.type('html').send(renderStepUpPage(req.params.id, { status: r.status, uri: r.uri, purpose: r.purpose }))
})
app.get('/present/:id/status', async (req, res) => {
  const r = await resolveStatus(deps, req.params.id)
  res.json({ status: r.status, claims: r.claims })
})

app.get('/', (_req, res) => res.json({ ok: true, mcp: `${BASE_URL}/mcp` }))

app.listen(PORT, () => {
  console.error(`eudi-agent-mcp example server on ${BASE_URL}  (MCP: ${BASE_URL}/mcp)`)
})
