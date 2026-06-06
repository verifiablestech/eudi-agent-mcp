import { DcqlQuery as DcqlQueryValidator } from 'dcql'
import type { DcqlQuery } from './types.js'

/**
 * Credential profiles + DCQL builder. A *profile* describes how to request a
 * credential type from the target wallet (doctype / vct / format / namespaces) —
 * this is deployment config, not something the agent should guess. The agent only
 * picks a `type` + the `claims` it needs; the server resolves the profile.
 */

export interface CredentialProfile {
  /** mdoc doctype, e.g. 'eu.europa.ec.eudi.pid.1'. */
  doctype: string
  /** SD-JWT VC type (vct). Issuer-defined; NOT the mdoc doctype. */
  vct?: string
  /** Default format for this credential. */
  format?: 'mso_mdoc' | 'dc+sd-jwt'
  /**
   * mso_mdoc namespace for claims. Defaults to `doctype`. Note the namespace is NOT
   * always the doctype: e.g. the mDL doctype is `org.iso.18013.5.1.mDL` but its namespace
   * is `org.iso.18013.5.1`.
   */
  namespace?: string
  /**
   * mso_mdoc per-claim namespace overrides, for credentials whose claims genuinely
   * span multiple namespaces. Rare in practice — most PID-family credentials keep
   * everything (including age-over claims) under a single namespace. Use this only
   * for credentials proven by deployment to need it.
   */
  claimNamespaces?: Record<string, string>
  /**
   * Explicit claim path override (either format). For SD-JWT this is the full claim path; for
   * mso_mdoc it is the full `[namespace, name]` path. Use it when neither the default nor the
   * conventions below produce the right path.
   */
  claimPaths?: Record<string, Array<string | number>>
}

/** Built-in defaults; override per deployment via `credentialProfiles`. */
export const DEFAULT_CREDENTIAL_PROFILES: Record<string, CredentialProfile> = {
  pid: { doctype: 'eu.europa.ec.eudi.pid.1', vct: 'urn:eudi:pid:1', format: 'mso_mdoc' },
  av: { doctype: 'eu.europa.ec.av.1', format: 'mso_mdoc' },
  // mDL: the namespace is org.iso.18013.5.1, NOT the doctype (org.iso.18013.5.1.mDL).
  mdl: { doctype: 'org.iso.18013.5.1.mDL', namespace: 'org.iso.18013.5.1', format: 'mso_mdoc' },
  photoid: { doctype: 'org.iso.23220.photoID.1', format: 'mso_mdoc' },
}

/**
 * Resolve the credential profiles for a deployment. With no overrides, returns the built-in
 * defaults. When overrides are provided, returns ONLY those types (each shallow-merged onto its
 * built-in default so you can override a single field) — so a deployment that configures only
 * `pid` exposes only `pid`, not `av`/`mdl`/`photoid`. The agent can only request what's exposed.
 */
export function mergeProfiles(
  overrides?: Record<string, CredentialProfile>
): Record<string, CredentialProfile> {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { ...DEFAULT_CREDENTIAL_PROFILES }
  }
  const merged: Record<string, CredentialProfile> = {}
  for (const [type, profile] of Object.entries(overrides)) {
    merged[type] = { ...DEFAULT_CREDENTIAL_PROFILES[type], ...profile }
  }
  return merged
}

/** mso_mdoc claim path: `[namespace, name]`, honouring per-claim namespace / path overrides. */
function mdocClaimPath(name: string, namespace: string, profile?: CredentialProfile): Array<string | number> {
  const override = profile?.claimPaths?.[name]
  if (override) return override
  return [profile?.claimNamespaces?.[name] ?? namespace, name]
}

/**
 * SD-JWT claim path. Honours explicit `claimPaths`, then applies the EUDI PID convention where age
 * thresholds are nested under `age_equal_or_over` (e.g. `age_over_18` → ['age_equal_or_over', '18']).
 * Everything else is a flat top-level claim.
 */
function sdJwtClaimPath(name: string, profile?: CredentialProfile): Array<string | number> {
  const override = profile?.claimPaths?.[name]
  if (override) return override
  const ageMatch = /^age_over_(\d+)$/.exec(name)
  if (ageMatch) return ['age_equal_or_over', ageMatch[1]]
  return [name]
}

/**
 * Translates a single (profile, claims) pair into a structurally-valid DCQL
 * query, then runs the result through `dcql`'s parser so shape errors
 * (malformed paths, missing fields, duplicate ids) surface here rather than
 * in the wallet round-trip.
 *
 * Internal: the only caller is `request_credential` after `resolvePurpose`
 * has produced a configured profile + claim list. Agents that need anything
 * fancier (multi-credential queries, alternative credential sets, raw doctypes)
 * use `request_presentation` with a hand-built DCQL query, which `dcql`
 * validates on its own path.
 */
export function purposeToDcql(
  type: string,
  profile: CredentialProfile,
  claims: string[]
): DcqlQuery {
  const format = profile.format ?? 'mso_mdoc'
  const id = type.replace(/[^a-zA-Z0-9_]/g, '_')
  const credential =
    format === 'dc+sd-jwt'
      ? {
          id,
          format: 'dc+sd-jwt' as const,
          meta: { vct_values: [profile.vct ?? type] },
          claims: claims.map((name) => ({ path: sdJwtClaimPath(name, profile) })),
        }
      : {
          id,
          format: 'mso_mdoc' as const,
          meta: { doctype_value: profile.doctype ?? type },
          claims: claims.map((name) => ({
            path: mdocClaimPath(name, profile.namespace ?? profile.doctype ?? type, profile),
            intent_to_retain: false,
          })),
        }

  // `DcqlQuery.parse` does shape + NonEmptyArray + unique-id + tuple-path
  // validation; it throws `DcqlParseError` if the helper produced something
  // malformed. Cast through `unknown` because `claimPaths` overrides allow
  // `(string | number)[]` (array indexing into a path) while `dcql`'s mso_mdoc
  // schema types the path as `[string, string]` — the parser is the source of
  // truth here, and an override that produces a wrong-shape path is precisely
  // what we want it to reject at runtime.
  const query = {
    credentials: [credential],
    credential_sets: [{ options: [[id]], required: true }],
  }
  return DcqlQueryValidator.parse(query as unknown as Parameters<typeof DcqlQueryValidator.parse>[0]) as unknown as DcqlQuery
}

// ──────────────────────────────────────────────────────────────────────────────
// Purpose registry — agent passes a label, server picks claims + credential.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Agent-facing semantic purpose. Operators register names (e.g. `age_gate`,
 * `basic_identity`, `kyc_basic`) and bind each to the claim set the server
 * should request. `types` is an optional ordered list of `credentialProfiles`
 * keys used to tiebreak when multiple profiles can serve the claims; the
 * first key that exists in `credentialProfiles` wins.
 */
export interface PurposeConfig {
  /** Claims the server should request when this purpose is invoked. */
  claims: string[]
  /** Preferred order of `credentialProfiles` keys to satisfy the claims. */
  types?: string[]
  /** Optional description shown above the QR / in instructions. */
  description?: string
}

export interface ResolvedPurpose {
  /** Effective claim list after purpose expansion. */
  claims: string[]
  /** First preferred type that actually exists in `profiles`, or `null` if
   *  none matched (caller falls back to per-profile scanning). */
  preferredType: string | null
}

/**
 * Expand a registered purpose into its claim list, intersected against the
 * configured `credentialProfiles` to pick the first preferred type that's
 * actually available. Returns `null` when `name` isn't registered.
 */
export function resolvePurpose(
  purposes: Record<string, PurposeConfig> | undefined,
  profiles: Record<string, CredentialProfile>,
  name: string
): ResolvedPurpose | null {
  if (!purposes) return null
  const cfg = purposes[name]
  if (!cfg) return null
  const preferredType = (cfg.types ?? []).find((t) => Object.prototype.hasOwnProperty.call(profiles, t)) ?? null
  return { claims: [...cfg.claims], preferredType }
}
