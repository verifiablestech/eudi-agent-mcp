import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { renderSVG } from 'uqr'
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import type { DcqlQuery, Oid4vpVerifier, Store } from './types.js'
import {
  mergeProfiles,
  purposeToDcql,
  resolvePurpose,
  type CredentialProfile,
  type PurposeConfig,
} from './dcql.js'
import {
  createVerification,
  resolveStatus,
  type VerificationDeps,
  type CreatedVerification,
} from './verification.js'

export interface IdentityServerOptions {
  verifier: Oid4vpVerifier
  /** Public base URL of the server (used to build step-up links). */
  baseUrl: string
  /** Store for per-verification state. Default: caller-provided (e.g. MemoryStore). */
  store: Store
  /**
   * How to request each credential type from the target wallet (doctype / vct /
   * format). When provided, this is the EXACT set the agent can request (each type
   * field-merged onto its built-in default); when omitted, the built-in defaults
   * (pid, av, mdl, photoid) are used. The agent only picks a type + claims.
   */
  credentialProfiles?: Record<string, CredentialProfile>
  /**
   * Registered semantic purposes the agent can call by name. Each entry binds
   * a label (e.g. `age_gate`, `basic_identity`, `kyc_basic`) to the claim set
   * the server should request, plus an optional ordered list of preferred
   * credential types. When the agent calls
   *   request_credential({ purpose: 'age_gate' })
   * the server expands the purpose, scans `credentialProfiles` for the first
   * preferred type that's configured (or falls back to any profile that can
   * serve the claims), and builds the OID4VP request itself. No claim list or
   * credential type is required from the agent in this path.
   *
   * `request_credential({ credentials: [...] })` remains the escape hatch for
   * callers that need to hand-pick the type / claims.
   */
  purposes?: Record<string, PurposeConfig>
  /**
   * Full override for the MCP server's `instructions` block (the long system
   * prompt the host shows to the model). When omitted the server auto-derives
   * one from `purposes`: a short preamble plus a bulleted list of every
   * registered purpose and its `description`. Override only when you need
   * strict control over the LLM-facing copy (compliance review, domain-
   * specific guidance the auto-derived text doesn't capture, etc.).
   */
  instructions?: string
  /** Branding shown to MCP clients. */
  serverInfo?: { name?: string; title?: string; version?: string; websiteUrl?: string; iconUrl?: string }
  /**
   * MCP Apps (SEP-1865) inline UI: when set, the presentation tools render the
   * QR inline in the chat via a sandboxed iframe (data via structuredContent).
   * Pass the self-contained widget HTML (e.g. from @verifiables/mcp-apps-widget).
   * Hosts without MCP Apps support fall back to the text link.
   */
  appUi?: { resourceHtml: string }
  /**
   * Tune the `get_presentation_status` long-poll. Defaults reflect what
   * works against most MCP hosts today:
   *   * `defaultSeconds`: 45  — used when the agent omits `waitSeconds`.
   *   * `maxSeconds`:     55  — hard cap (clamped). Going above ~55 s
   *                              starts to clash with HTTP write timeouts
   *                              on common reverse proxies.
   *   * `pollIntervalMs`: 2000 — internal poll cadence inside the wait
   *                              window. Rarely worth tuning.
   */
  longPoll?: { defaultSeconds?: number; maxSeconds?: number; pollIntervalMs?: number }
  /**
   * How long (seconds) a verification record lives in the store after the
   * wallet completes. Forwarded to the verification service as
   * `VerificationDeps.recordTtl`. Default: 600 s (10 min).
   */
  verificationRecordTtl?: number
}

const DEFAULT_LONG_POLL_SECONDS = 45
const MAX_LONG_POLL_SECONDS = 55
const DEFAULT_POLL_INTERVAL_MS = 2000

/**
 * Auto-derive an `instructions` block from the configured purposes registry.
 * The preamble is generic ("verify the user with a credential, prefer verified
 * data over user input") and a bulleted "Configured purposes" section names
 * every registered purpose plus its `description`. Operators describe their
 * use cases in the purpose registry; the LLM-facing copy follows automatically.
 *
 * When no purposes are configured, falls back to a minimal preamble pointing
 * at the escape-hatch path (`credentials: [...]`).
 */
export function deriveInstructions(
  purposes: Record<string, PurposeConfig> | undefined,
  configuredTypes: string[]
): string {
  const preamble =
    `You are connected to an EUDI Identity Bridge MCP server. It lets you require the user to prove ` +
    `facts about themselves with their EU Digital Identity Wallet, signed by their government, before you ` +
    `assist with anything that depends on those facts. All disclosed claims are cryptographically verified — ` +
    `prefer them over user-typed information every time.`

  const entries = Object.entries(purposes ?? {})
  if (entries.length === 0) {
    return (
      `${preamble}\n\n` +
      `No semantic purposes are registered for this deployment, so request_credential is not usable. ` +
      `For one-off ad-hoc queries, call request_presentation with a raw DCQL query. ` +
      `(Configured credential types in the registry: ${configuredTypes.join(', ') || '(none)'}.)`
    )
  }

  const bulleted = entries
    .map(([name, cfg]) => {
      const desc = cfg.description ? ` — ${cfg.description}` : ''
      return `  • ${name}${desc}`
    })
    .join('\n')

  return (
    `${preamble}\n\n` +
    `MANDATORY: Whenever the user is about to do something one of the configured purposes covers, ` +
    `CALL request_credential FIRST. Do not assist, recommend, give instructions, or take the action and then ` +
    `verify after the fact. Verify, then proceed only if status === "verified".\n\n` +
    `Configured purposes:\n${bulleted}\n\n` +
    `Call request_credential({ purpose: "<one of the above>", reason: "<short user-facing explanation>" }). You never pick a credential type, format, or claim list ` +
    `— those are deployment decisions the server makes from the purpose. ALWAYS supply a contextual reason ("to confirm you are 18+ before completing your wine order"); ` +
    `it's rendered above the QR and dramatically improves the user's understanding of why they're being asked to verify.\n\n` +
    `What counts as "an action that needs verification": purchase / order / sign-up / booking / transfer / access of anything ` +
    `the purpose descriptions match. Informational questions about the topic ("what's the drinking age?", "how does KYC work?") ` +
    `don't trigger verification. The gated thing is the action, access, or transaction, not the discussion of it. When in doubt, ` +
    `verify; a verification step the user breezes through is cheaper than an ungated action you'll regret.\n\n` +
    `If the user declines, the verification fails, or it expires, REFUSE the gated action — don't fall back to taking their word ` +
    `for it. If no registered purpose fits the use case, use request_presentation with a raw DCQL query.`
  )
}

const QR_RESOURCE_URI = 'ui://eudi-agent/verify-qr.html'

export function createIdentityMcpServer(opts: IdentityServerOptions): McpServer {
  const deps: VerificationDeps = {
    verifier: opts.verifier,
    store: opts.store,
    baseUrl: opts.baseUrl,
    ...(opts.verificationRecordTtl !== undefined ? { recordTtl: opts.verificationRecordTtl } : {}),
  }
  const longPollDefault = opts.longPoll?.defaultSeconds ?? DEFAULT_LONG_POLL_SECONDS
  const longPollMax = opts.longPoll?.maxSeconds ?? MAX_LONG_POLL_SECONDS
  const longPollInterval = opts.longPoll?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const info = opts.serverInfo ?? {}
  const profiles = mergeProfiles(opts.credentialProfiles)

  // Instructions are either fully overridden by the deployment or
  // auto-derived from the purposes registry. Avoid baking domain-
  // specific examples (retail / age-restricted goods) into the
  // generic preamble; if an operator wants that emphasis, they put
  // it in the `age_gate` purpose's `description` and it surfaces
  // automatically. Compliance teams that need full copy control
  // pass `instructions` directly.
  const instructions = opts.instructions ?? deriveInstructions(opts.purposes, Object.keys(profiles))

  const server = new McpServer(
    {
      name: info.name ?? 'eudi-agent-identity',
      title: info.title ?? 'EUDI Agent Identity',
      version: info.version ?? '0.1.0',
      ...(info.websiteUrl ? { websiteUrl: info.websiteUrl } : {}),
      ...(info.iconUrl ? { icons: [{ src: info.iconUrl, sizes: ['any'] }] } : {}),
    },
    { instructions }
  )

  const asText = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  })

  // MCP Apps inline-QR resource (registered once when appUi is enabled).
  if (opts.appUi) {
    registerAppResource(
      server,
      'verify-qr',
      QR_RESOURCE_URI,
      { mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [{ uri: QR_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: opts.appUi!.resourceHtml }],
      })
    )
  }

  /** Tool result for a presentation request: text fallback always, plus inline-QR
   *  structuredContent when MCP Apps is enabled. */
  function presentationResult(v: CreatedVerification, purpose: string | undefined) {
    const text = `Ask the user to open ${v.stepUpUrl} and present their credential with their EUDIW wallet, then poll get_presentation_status with verificationId "${v.id}". Only proceed once status is "verified".`
    const result: { content: { type: 'text'; text: string }[]; structuredContent?: unknown } = {
      content: [{ type: 'text', text }],
    }
    if (opts.appUi) {
      result.structuredContent = {
        verificationId: v.id,
        requestUri: v.uri,
        pageUrl: v.stepUpUrl,
        purpose,
        qrSvg: renderSVG(v.uri, { border: 1 }),
      }
    }
    return result
  }

  /** Register a presentation-initiating tool as an MCP Apps tool (inline QR) when
   *  appUi is set, else a plain tool. */
  function registerInitTool(
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: Record<string, unknown>) => Promise<ReturnType<typeof presentationResult>>
  ) {
    if (opts.appUi) {
      registerAppTool(
        server,
        name,
        { description, inputSchema: schema, _meta: { ui: { resourceUri: QR_RESOURCE_URI } } } as never,
        handler as never
      )
    } else {
      server.tool(name, description, schema, handler as never)
    }
  }

  // request_credential — the primary tool. Strictly purpose-driven: the agent
  // names a registered purpose, the server resolves it to claims + credential
  // type + format + DCQL. No credential type, format, or claim list is ever
  // accepted from the agent here — those are deployment decisions the LLM is
  // bad at and shouldn't be invited to make. Operators who need fine-grained
  // control use request_presentation with raw DCQL instead.
  const purposeEntries = Object.entries(opts.purposes ?? {})
  const purposeNamesList = purposeEntries.length
    ? purposeEntries.map(([n]) => n).join(', ')
    : '(none)'
  const purposeBulletList = purposeEntries
    .map(([name, cfg]) => `  • ${name}${cfg.description ? ` — ${cfg.description}` : ''}`)
    .join('\n')

  registerInitTool(
    'request_credential',
    `Verify the user with a credential from their EUDI wallet BEFORE fulfilling, completing, or unlocking any action that one of the configured purposes covers. CALL THIS TOOL FIRST in those cases — do NOT answer from general knowledge, give recommendations, or take the action and then verify after the fact.

Configured purposes for this deployment:
${purposeBulletList || '  (none — request_credential is not usable; use request_presentation with raw DCQL instead)'}

Read each purpose's description carefully and call request_credential({ purpose: "<name>" }) whenever the user's request matches one. Examples of when to fire:
  • Anything the operator's purpose descriptions cover (alcohol / tobacco / gambling / adult content / age-restricted goods if there's an age-gating purpose, account creation / form fill if there's an identity purpose, financial or employment onboarding if there's a KYC purpose, etc.)
  • Any action / access / transaction that would benefit from cryptographic proof of who the user is, rather than taking their word for it.
  • Ethically sensitive, high-stakes, or legally gray requests where accountability matters.

Gate the ACTION, ACCESS, or TRANSACTION — not informational questions about the topic ("what's the drinking age?" needs no verification; "order me a bottle of wine" does). When an action is gated, refuse to fulfil it from general knowledge first; verify, then proceed only once status is "verified".

Always pass a contextual \`reason\` — a short user-facing sentence shown above the QR (e.g. "to confirm you are 18+ before completing your wine order", "to verify your name before signing this contract"). The user is much more likely to scan the QR when they see the reason than when they just see a generic "Verify with your wallet" prompt. Skip \`reason\` only when there's truly no context (rare).

Returns a verification link + verificationId. Poll get_presentation_status (long-poll, default 45 s) and continue only when status is "verified". The disclosed claims will be in the result. If the user declines or the verification fails / expires, REFUSE the gated action.

When no registered purpose fits a one-off case, use request_presentation with a raw DCQL query instead.`,
    {
      purpose: z
        .string()
        .describe(
          `Registered purpose name. Must match one of: ${purposeNamesList}. The server resolves the purpose into the right claims, credential type, format, and DCQL; the agent never picks any of those itself.`
        ),
      reason: z
        .string()
        .optional()
        .describe(
          `Short, user-facing explanation shown above the QR (e.g. "to confirm you are 18+ before completing your wine order"). Optional but strongly recommended — it turns an abstract "Verify with your wallet" prompt into a contextual one the user understands. Falls back to the purpose's static description when omitted.`
        ),
    },
    async ({ purpose, reason }) => {
      if (typeof purpose !== 'string' || purpose.length === 0) {
        throw new Error(`request_credential needs a registered purpose. Configured purposes: ${purposeNamesList}.`)
      }
      const resolved = resolvePurpose(opts.purposes, profiles, purpose)
      if (!resolved) {
        throw new Error(
          `Purpose "${purpose}" is not registered. Configured purposes: ${purposeNamesList}. ` +
            `For one-off ad-hoc queries that no registered purpose fits, use request_presentation with a raw DCQL query.`
        )
      }
      // Pick the first preferred type that's available; if none of the preferred
      // types are configured, fall back to the first profile key. Operators
      // should align purposes.types with their credentialProfiles keys to make
      // resolution deterministic.
      const type = resolved.preferredType ?? Object.keys(profiles)[0]
      if (!type) {
        throw new Error('No credentialProfiles are configured; cannot resolve a purpose without at least one profile.')
      }
      // The user-facing line above the QR. Agent-supplied `reason` wins
      // because it's tied to the moment ("…before completing your wine
      // order"); the static purpose description is the fallback when the
      // agent didn't bother.
      const displayLine =
        (typeof reason === 'string' && reason.length > 0 ? reason : undefined) ??
        opts.purposes?.[purpose]?.description ??
        purpose
      const v = await createVerification(deps, {
        dcql: purposeToDcql(type, profiles[type], resolved.claims),
        purpose: displayLine,
      })
      return presentationResult(v, displayLine)
    }
  )

  // request_presentation — escape hatch: pass a raw DCQL query.
  registerInitTool(
    'request_presentation',
    'Request a presentation via a raw DCQL query (OpenID4VP 1.0) when request_credential is not expressive enough. Poll get_presentation_status for the disclosed claims.',
    {
      dcql: z.any().describe('A DCQL query object.'),
      reason: z
        .string()
        .optional()
        .describe('Short, user-facing explanation shown above the QR (e.g. "to verify your mDL before issuing a rental contract").'),
    },
    async ({ dcql, reason }) => {
      const v = await createVerification(deps, { dcql: dcql as DcqlQuery, purpose: reason as string })
      return presentationResult(v, reason as string | undefined)
    }
  )

  // get_presentation_status — long-polls a request_credential / request_presentation: it WAITS
  // (server-side) for the user to respond instead of returning immediately, so you call it once
  // rather than polling in a loop. If it returns "pending" (the wait window elapsed), call it again.
  server.tool(
    'get_presentation_status',
    `Wait for and check a request_credential / request_presentation. This BLOCKS server-side until the user responds (up to ~${longPollMax}s), then returns "pending", "verified" (with the disclosed claims), "failed", or "expired" — so call it ONCE after giving the user the link, and only call again if it returns "pending". For age gating, check the disclosed claims include age_over_18: true. Only proceed once "verified".`,
    {
      verificationId: z.string().describe('The verificationId from request_credential / request_presentation.'),
      waitSeconds: z
        .number()
        .optional()
        .describe(`How long to wait for the user to respond before returning (default ${longPollDefault}, max ${longPollMax}; 0 = return immediately).`),
    },
    async ({ verificationId, waitSeconds }) => {
      const cap = Math.min(Math.max(waitSeconds ?? longPollDefault, 0), longPollMax)
      const deadline = Date.now() + cap * 1000
      let r = await resolveStatus(deps, verificationId)
      while (r.status === 'pending' && Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, longPollInterval))
        r = await resolveStatus(deps, verificationId)
      }
      return asText({ verificationId, status: r.status, claims: r.claims })
    }
  )

  return server
}
