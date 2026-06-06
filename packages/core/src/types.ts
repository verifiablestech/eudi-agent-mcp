/**
 * The integration seam. An MCP server built with this package never talks to a
 * specific verifier — it talks to an `Oid4vpVerifier`. Implement this once per
 * OID4VP backend (EUDI reference verifier, an in-process @openid4vc library, a
 * commercial verifier, ...) and the agent-facing tools work unchanged.
 */

// The canonical DCQL query type comes from `dcql`
// (https://github.com/openwallet-foundation-labs/dcql-ts), the OpenWallet
// Foundation labs project. Re-exported so adapters can use the same nominal
// type the rest of the ecosystem uses without taking a direct dep on `dcql`.
export type { DcqlQuery } from 'dcql'
import type { DcqlQuery } from 'dcql'

export interface PresentationQuery {
  /** The DCQL describing what to request from the wallet. */
  dcql: DcqlQuery
  /** Human-readable purpose, shown to the user where supported. */
  purpose?: string
}

export interface CreatedRequest {
  /** Opaque id used to fetch the result later (e.g. the verifier transaction id). */
  id: string
  /** Wallet-facing authorization request URI (render as QR / open as deep link). */
  uri: string
  /** Optional expiry (epoch ms). */
  expiresAt?: number
}

export type VerificationStatus = 'pending' | 'verified' | 'failed' | 'expired'

export interface VerificationResult {
  status: VerificationStatus
  /** Disclosed claims, flattened where the adapter can (e.g. { age_over_18: true }). */
  claims?: Record<string, unknown>
}

/** The single interface every OID4VP backend implements. */
export interface Oid4vpVerifier {
  /** Mint an OID4VP request for `query`; return its id + wallet-facing URI. */
  createRequest(query: PresentationQuery): Promise<CreatedRequest>
  /** Resolve the current result. `pending` until the wallet has responded. */
  getResult(id: string): Promise<VerificationResult>
}

/** Minimal key/value store with TTL. Default is in-memory; swap for Redis etc. */
export interface Store {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds?: number): Promise<void>
  del(key: string): Promise<void>
}
