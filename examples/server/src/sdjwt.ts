/**
 * Minimal SD-JWT VC claim extraction.
 *
 * Returns a flat object of disclosed claims from an SD-JWT VC presentation
 * (issuer JWT + `~`-separated disclosures + optional Key Binding JWT). This is
 * extraction only — it assumes the presentation was already cryptographically
 * verified by the verifier (signature, key binding, digest integrity). Use it to
 * read disclosed values like `age_over_18` out of a verified presentation.
 */
export function decodeSdJwtVcClaims(compact: string): Record<string, unknown> {
  const parts = compact.split('~')
  const claims: Record<string, unknown> = {}

  // 1) Always-disclosed claims from the issuer JWT payload (drop SD internals).
  const jwt = parts[0]
  const payloadSeg = jwt?.split('.')[1]
  if (payloadSeg) {
    try {
      const payload = JSON.parse(Buffer.from(payloadSeg, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >
      for (const [k, v] of Object.entries(payload)) {
        if (k === '_sd' || k === '_sd_alg' || k === 'cnf') continue
        claims[k] = v
      }
    } catch {
      /* ignore malformed payload */
    }
  }

  // 2) Selectively-disclosed claims. Disclosures are base64url JSON arrays.
  //    A trailing Key Binding JWT (contains '.') and empty segments are skipped.
  for (const part of parts.slice(1)) {
    if (!part || part.includes('.')) continue
    try {
      const arr = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
      // Object property disclosure: [salt, claimName, claimValue].
      if (Array.isArray(arr) && arr.length === 3 && typeof arr[1] === 'string') {
        claims[arr[1]] = arr[2]
      }
      // Array-element disclosures ([salt, value]) are not flattened here.
    } catch {
      /* ignore malformed disclosure */
    }
  }

  return claims
}
