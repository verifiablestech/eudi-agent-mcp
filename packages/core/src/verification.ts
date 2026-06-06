import type { Oid4vpVerifier, PresentationQuery, Store, VerificationStatus } from './types.js'

/**
 * Verification service shared by the MCP tools and the example server's HTTP
 * endpoints. Bridges a `PresentationQuery` to the configured `Oid4vpVerifier`
 * and tracks the small amount of per-verification state the step-up page needs.
 */

export interface VerificationDeps {
  verifier: Oid4vpVerifier
  store: Store
  /** Public base URL of the MCP/example server, used to build the step-up link. */
  baseUrl: string
  /**
   * How long (seconds) a verification record stays in the store after the
   * verifier resolves. Long enough that `get_presentation_status` keeps
   * answering past the wallet's terminal response, short enough that
   * stale results don't accumulate. Default: 600 s (10 min).
   */
  recordTtl?: number
}

const DEFAULT_RECORD_TTL = 600
const recordKey = (id: string) => `verification:${id}`

interface VerificationRecord {
  uri: string
  purpose?: string
  resolved?: { status: VerificationStatus; claims?: Record<string, unknown> }
}

export interface CreatedVerification {
  id: string
  uri: string
  stepUpUrl: string
}

export async function createVerification(
  deps: VerificationDeps,
  query: PresentationQuery
): Promise<CreatedVerification> {
  const created = await deps.verifier.createRequest(query)
  const record: VerificationRecord = { uri: created.uri, purpose: query.purpose }
  await deps.store.set(recordKey(created.id), JSON.stringify(record), deps.recordTtl ?? DEFAULT_RECORD_TTL)

  return {
    id: created.id,
    uri: created.uri,
    stepUpUrl: `${deps.baseUrl.replace(/\/$/, '')}/present/${created.id}`,
  }
}

export interface ResolvedStatus {
  status: VerificationStatus | 'not_found'
  claims?: Record<string, unknown>
  uri?: string
  purpose?: string
}

export async function resolveStatus(deps: VerificationDeps, id: string): Promise<ResolvedStatus> {
  const raw = await deps.store.get(recordKey(id))
  const record: VerificationRecord | null = raw ? JSON.parse(raw) : null

  if (record?.resolved) {
    return { ...record.resolved, uri: record.uri, purpose: record.purpose }
  }

  const result = await deps.verifier.getResult(id)

  // Cache terminal results so they survive verifier-side expiry.
  if (record && result.status !== 'pending') {
    record.resolved = { status: result.status, claims: result.claims }
    await deps.store.set(recordKey(id), JSON.stringify(record), deps.recordTtl ?? DEFAULT_RECORD_TTL)
  }

  return {
    status: record ? result.status : result.status === 'pending' ? 'not_found' : result.status,
    claims: result.claims,
    uri: record?.uri,
    purpose: record?.purpose,
  }
}

/** Recursively finds a boolean claim by name anywhere in the disclosed claims. */
export function findBooleanClaim(value: unknown, name: string): boolean | undefined {
  if (value === null || typeof value !== 'object') return undefined
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === name && typeof v === 'boolean') return v
    const nested = findBooleanClaim(v, name)
    if (nested !== undefined) return nested
  }
  return undefined
}
