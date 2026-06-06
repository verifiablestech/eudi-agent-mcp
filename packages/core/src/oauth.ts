import { createHash, randomBytes } from 'node:crypto'
import type { Store } from './types.js'

/**
 * Minimal OAuth 2.1 authorization server for MCP clients (the custom
 * connector requires it: RFC 9728 protected-resource metadata, RFC 8414 AS
 * metadata, RFC 7591 dynamic client registration, authorization code + PKCE,
 * RFC 8707 resource/audience binding).
 *
 * Auto-approve by default: it authenticates the *client* (the agent), not a
 * human — the human is verified later by the wallet presentation. Provide an
 * `onAuthorize` hook to add real consent/login before exposing real data.
 */

export interface OAuthOptions {
  store: Store
  /** Public base URL, e.g. https://host (no trailing slash). */
  baseUrl: string
  /**
   * Optional gate run at /authorize before a code is issued. Return false to
   * deny (e.g. to require a real login/consent). Default: always approve.
   */
  onAuthorize?: (ctx: { clientId: string; redirectUri: string; scope: string }) => boolean | Promise<boolean>
  /**
   * Override OAuth token lifetimes (seconds). Defaults reflect typical
   * MCP-client expectations:
   *   * `code`:    300       — authorization code, brief on purpose.
   *   * `access`:  3600      — bearer access token.
   *   * `refresh`: 2592000   — refresh token (30 days).
   * Tighten in deployments that want smaller blast radius from a leaked
   * token; loosen for long-running demos where reconnects are expensive.
   */
  ttls?: { code?: number; access?: number; refresh?: number }
}

export interface TokenRecord {
  client_id: string
  resource: string
  scope: string
}

const DEFAULT_CODE_TTL = 300
const DEFAULT_ACCESS_TTL = 3600
const DEFAULT_REFRESH_TTL = 60 * 60 * 24 * 30

const clientKey = (id: string) => `oauth:client:${id}`
const codeKey = (c: string) => `oauth:code:${c}`
const tokenKey = (t: string) => `oauth:token:${t}`
const refreshKey = (t: string) => `oauth:refresh:${t}`

const b64u = (buf: Buffer) => buf.toString('base64url')
const randomToken = () => b64u(randomBytes(32))

export function createOAuth(opts: OAuthOptions) {
  const base = opts.baseUrl.replace(/\/$/, '')
  const resource = `${base}/mcp`
  const store = opts.store
  const CODE_TTL = opts.ttls?.code ?? DEFAULT_CODE_TTL
  const ACCESS_TTL = opts.ttls?.access ?? DEFAULT_ACCESS_TTL
  const REFRESH_TTL = opts.ttls?.refresh ?? DEFAULT_REFRESH_TTL

  const protectedResourceMetadataUrl = () => `${base}/.well-known/oauth-protected-resource`

  function protectedResourceMetadata() {
    return { resource, authorization_servers: [base], bearer_methods_supported: ['header'] }
  }

  function authorizationServerMetadata() {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    }
  }

  async function registerClient(body: { redirect_uris?: unknown; client_name?: unknown }) {
    const redirect_uris = Array.isArray(body.redirect_uris)
      ? (body.redirect_uris.filter((u) => typeof u === 'string') as string[])
      : []
    const client = {
      client_id: `mcp_${b64u(randomBytes(16))}`,
      redirect_uris,
      client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
    }
    await store.set(clientKey(client.client_id), JSON.stringify(client))
    return client
  }

  type AuthorizeResult = { redirect: string } | { error: string; status: number }

  async function authorize(p: {
    client_id?: string
    redirect_uri?: string
    code_challenge?: string
    code_challenge_method?: string
    state?: string
    scope?: string
    resource?: string
  }): Promise<AuthorizeResult> {
    if (!p.client_id || !p.redirect_uri || !p.code_challenge) {
      return { error: 'invalid_request', status: 400 }
    }
    if ((p.code_challenge_method ?? 'S256') !== 'S256') {
      return { error: 'invalid_request', status: 400 }
    }
    const raw = await store.get(clientKey(p.client_id))
    if (!raw) return { error: 'invalid_client', status: 400 }
    const client = JSON.parse(raw) as { redirect_uris: string[] }
    if (!client.redirect_uris.includes(p.redirect_uri)) {
      return { error: 'invalid_request', status: 400 }
    }
    const scope = p.scope ?? 'mcp'
    if (opts.onAuthorize) {
      const ok = await opts.onAuthorize({ clientId: p.client_id, redirectUri: p.redirect_uri, scope })
      if (!ok) return { error: 'access_denied', status: 403 }
    }

    const code = randomToken()
    await store.set(
      codeKey(code),
      JSON.stringify({
        client_id: p.client_id,
        redirect_uri: p.redirect_uri,
        code_challenge: p.code_challenge,
        resource: p.resource ?? resource,
        scope,
      }),
      CODE_TTL
    )
    const url = new URL(p.redirect_uri)
    url.searchParams.set('code', code)
    if (p.state) url.searchParams.set('state', p.state)
    return { redirect: url.toString() }
  }

  async function issueTokens(record: TokenRecord) {
    const access_token = randomToken()
    const refresh_token = randomToken()
    await store.set(tokenKey(access_token), JSON.stringify(record), ACCESS_TTL)
    await store.set(refreshKey(refresh_token), JSON.stringify(record), REFRESH_TTL)
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope: record.scope }
  }

  async function token(body: Record<string, unknown>) {
    const grant = body.grant_type
    if (grant === 'authorization_code') {
      const raw = await store.get(codeKey(String(body.code)))
      if (!raw) return { error: 'invalid_grant', status: 400 }
      await store.del(codeKey(String(body.code)))
      const c = JSON.parse(raw) as {
        client_id: string
        redirect_uri: string
        code_challenge: string
        resource: string
        scope: string
      }
      if (c.client_id !== body.client_id) return { error: 'invalid_grant', status: 400 }
      if (c.redirect_uri !== body.redirect_uri) return { error: 'invalid_grant', status: 400 }
      const computed = b64u(createHash('sha256').update(String(body.code_verifier)).digest())
      if (computed !== c.code_challenge) return { error: 'invalid_grant', status: 400 }
      return await issueTokens({ client_id: c.client_id, resource: c.resource, scope: c.scope })
    }
    if (grant === 'refresh_token') {
      const raw = await store.get(refreshKey(String(body.refresh_token)))
      if (!raw) return { error: 'invalid_grant', status: 400 }
      await store.del(refreshKey(String(body.refresh_token)))
      return await issueTokens(JSON.parse(raw) as TokenRecord)
    }
    return { error: 'unsupported_grant_type', status: 400 }
  }

  async function validateAccessToken(token: string | undefined): Promise<TokenRecord | null> {
    if (!token) return null
    const raw = await store.get(tokenKey(token))
    if (!raw) return null
    const record = JSON.parse(raw) as TokenRecord
    const norm = (s: string) => s.replace(/\/$/, '').toLowerCase()
    if (record.resource && norm(record.resource) !== norm(resource) && norm(record.resource) !== norm(base)) {
      return null
    }
    return record
  }

  return {
    resource,
    protectedResourceMetadata,
    protectedResourceMetadataUrl,
    authorizationServerMetadata,
    registerClient,
    authorize,
    token,
    validateAccessToken,
  }
}

export type OAuth = ReturnType<typeof createOAuth>
