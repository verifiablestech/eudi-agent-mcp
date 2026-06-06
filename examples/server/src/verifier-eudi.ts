import { randomUUID } from 'node:crypto'
import { decodeSdJwtVcClaims } from './sdjwt.js'
import type {
  CreatedRequest,
  Oid4vpVerifier,
  PresentationQuery,
  VerificationResult,
} from '@verifiables/eudi-mcp-core'

/**
 * Oid4vpVerifier adapter for the EUDI reference Verifier Endpoint
 * (https://verifier-backend.eudiw.dev). OpenID4VP 1.0, DCQL, no auth.
 *
 *   init   → POST /ui/presentations/v2  { dcql_query, nonce, jar_mode: by_reference }
 *            → { transaction_id, authorization_request_uri }
 *   result → GET  /ui/presentations/{id}  (404 while pending, 200 = { vp_token: {…} })
 *   decode → POST /utilities/validations/msoMdoc/deviceResponse (form device_response)
 *            → [ { docType, attributes: { age_over_18: true, … } } ]
 */

export interface EudiVerifierOptions {
  /** Verifier backend base URL. Default: https://verifier-backend.eudiw.dev */
  baseUrl?: string
  /** OID4VP profile. Default: 'openid4vp'. */
  profile?: 'openid4vp' | 'haip'
  fetchFn?: typeof fetch
}

const DEFAULT_BASE = 'https://verifier-backend.eudiw.dev'

export class EudiVerifier implements Oid4vpVerifier {
  #base: string
  #profile: 'openid4vp' | 'haip'
  #fetch: typeof fetch

  constructor(opts: EudiVerifierOptions = {}) {
    this.#base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    this.#profile = opts.profile ?? 'openid4vp'
    this.#fetch = opts.fetchFn ?? fetch
  }

  async createRequest(query: PresentationQuery): Promise<CreatedRequest> {
    const res = await this.#fetch(`${this.#base}/ui/presentations/v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        dcql_query: query.dcql,
        nonce: randomUUID(),
        jar_mode: 'by_reference',
        request_uri_method: 'get',
        profile: this.#profile,
      }),
    })
    if (!res.ok) {
      throw new Error(`EUDI verifier init failed: ${res.status} ${await res.text()}`)
    }
    const body = (await res.json()) as {
      transaction_id?: string
      authorization_request_uri?: string
    }
    const id = body.transaction_id ?? res.headers.get('Transaction-Id') ?? ''
    const uri = body.authorization_request_uri ?? res.headers.get('Authorization-Request-Uri') ?? ''
    if (!id || !uri) throw new Error('EUDI verifier init: missing transaction_id / authorization_request_uri')
    return { id, uri }
  }

  async getResult(id: string): Promise<VerificationResult> {
    const res = await this.#fetch(`${this.#base}/ui/presentations/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
    })
    // The verifier returns a non-200 (typically 404) until the wallet responds.
    if (!res.ok) return { status: 'pending' }

    const body = (await res.json()) as {
      vp_token?: Record<string, unknown[]>
      error?: string
    }
    if (body.error) return { status: 'failed' }
    if (!body.vp_token) return { status: 'pending' }

    const claims = await this.#extractClaims(body.vp_token)
    return { status: 'verified', claims }
  }

  /** Decodes the first presentation (SD-JWT VC or mso_mdoc) into flat claims. */
  async #extractClaims(vpToken: Record<string, unknown[]>): Promise<Record<string, unknown> | undefined> {
    const first = Object.values(vpToken).flat().find((p) => typeof p === 'string') as string | undefined
    if (!first) return undefined

    // SD-JWT VC compact form contains JWT segments (dots); mso_mdoc is base64url
    // CBOR (no dots). Decode SD-JWT locally; decode mdoc via the EUDI utility.
    if (first.includes('.')) {
      return decodeSdJwtVcClaims(first)
    }

    try {
      const res = await this.#fetch(`${this.#base}/utilities/validations/msoMdoc/deviceResponse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ device_response: first }).toString(),
      })
      if (!res.ok) return undefined
      const docs = (await res.json()) as Array<{ docType?: string; attributes?: Record<string, unknown> }>
      const claims: Record<string, unknown> = {}
      for (const doc of docs) Object.assign(claims, doc.attributes ?? {})
      return claims
    } catch {
      return undefined
    }
  }
}

export function createEudiVerifier(opts?: EudiVerifierOptions): EudiVerifier {
  return new EudiVerifier(opts)
}
