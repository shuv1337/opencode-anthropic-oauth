/**
 * Host-agnostic core: option parsing, credential precedence, and the global
 * fetch patch. Shared by both plugin entrypoints so neither host wrapper owns
 * logic the other needs.
 *
 *   v2.ts  -> promise plugin  (@opencode-ai/plugin/v2, builds <= next-15353)
 *   v3.ts  -> Effect plugin   (@opencode-ai/plugin 2.0.0-alpha-3+)
 *
 * Nothing here may import a host plugin package: v3 runs on builds where the
 * `/v2` subpath no longer exists, so a shared module that touched it would
 * fail at import time before either plugin could register.
 */
import { oauthRequest } from "./shared.js"

export const INTEGRATION_ID = "anthropic"
export const METHOD_ID = "claude-pro-max"
export const SENTINEL_KEY = "opencode-anthropic-oauth"

export interface V2Options {
  allowClaudeCliFallback: boolean
  allowV1AuthFallback: boolean
}

interface FetchPatchRecord {
  owner: symbol
  wrapper: typeof fetch
  previous: typeof fetch
  active: boolean
}

const FETCH_PATCH = Symbol.for("opencode-anthropic-oauth.fetch-patch")
export const debug = (message: string) => {
  if (process.env.OPENCODE_ANTHROPIC_OAUTH_DEBUG === "1") console.error(`[anthropic-oauth] ${message}`)
}

export function parseV2Options(input: Readonly<Record<string, unknown>>): V2Options {
  for (const key of ["allowClaudeCliFallback", "allowV1AuthFallback"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") {
      throw new Error(`opencode-anthropic-oauth: ${key} must be a boolean`)
    }
  }
  return {
    allowClaudeCliFallback: input.allowClaudeCliFallback === true,
    allowV1AuthFallback: input.allowV1AuthFallback === true,
  }
}

const readHeader = (input: RequestInfo | URL, init: RequestInit | undefined, name: string): string | undefined => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers.get(name) ?? undefined
}

/**
 * Injectable credential-source bundle. Extracted so the precedence logic can
 * be unit-tested without a live host context, real files, or the network —
 * the same dependency-injection seam used by `oauthRequest`/`fetchWithRetry`.
 */
export interface CredentialResolution {
  apiKeyEnv: string | undefined
  /** `CLAUDE_CODE_OAUTH_TOKEN` — a long-lived `sk-ant-oat*` token as minted by
   *  `claude setup-token`. This is the only OAuth source that needs no browser
   *  and no interactive attempt, which makes it the practical answer for a
   *  headless deployment: a daemon under systemd never has a browser, and a
   *  stored attempt cannot be created without one.
   *
   *  Note it is NOT read from a login shell in that setting — systemd units do
   *  not source `.bashrc` — so it belongs in the unit's EnvironmentFile. */
  setupTokenEnv: string | undefined
  activeCredential: () => Promise<{ type?: string; access?: string } | undefined>
  allowClaudeCliFallback: boolean
  allowV1AuthFallback: boolean
  hasCliCredentials: () => boolean
  hasV1OAuthEntry: () => boolean
  getCliAccessToken: () => Promise<string | null>
  getV1AuthAccessToken: () => Promise<string | null>
}

/**
 * Decide whether OAuth interception is active. Precedence:
 *   1. An explicit API key (env `ANTHROPIC_API_KEY` or a V2 `key` credential)
 *      always disables OAuth interception.
 *   2. A V2 OAuth connection enables it.
 *   3. `CLAUDE_CODE_OAUTH_TOKEN` enables it. Ranked below a stored connection
 *      so an interactively-connected account still wins on a host that also
 *      happens to export the variable, and above the opt-in fallbacks because
 *      it is explicit configuration rather than an ambient local artifact.
 *   4. Claude CLI / V1 auth.json only apply when their opt-in flags are set.
 */
export async function isOauthModeActive(d: CredentialResolution): Promise<boolean> {
  if (d.apiKeyEnv?.trim()) return false
  try {
    const credential = await d.activeCredential()
    if (credential?.type === "key") return false
    if (credential?.type === "oauth") return true
  } catch {
    // Explicit fallback sources remain available if configured.
  }
  if (d.setupTokenEnv?.trim()) return true
  return (d.allowClaudeCliFallback && d.hasCliCredentials())
    || (d.allowV1AuthFallback && d.hasV1OAuthEntry())
}

/**
 * Resolve the OAuth access token to authorize a request with, honouring the
 * same precedence as `isOauthModeActive`. Returns null for API-key modes and
 * when no OAuth credential is available.
 */
export async function resolveAccessToken(d: CredentialResolution): Promise<string | null> {
  // Mirrors rule 1 of `isOauthModeActive`. Both callers gate on that function
  // first, so this is defence in depth rather than a live fix — but the two
  // must not disagree about what an explicit API key means, or a future caller
  // that resolves a token without checking the mode would silently authorize a
  // subscription request on a host configured for key billing.
  if (d.apiKeyEnv?.trim()) return null
  try {
    const credential = await d.activeCredential()
    if (credential?.type === "key") return null
    if (credential?.type === "oauth") return credential.access ?? null
  } catch {
    // Continue only through explicitly enabled isolated fallbacks.
  }
  const setupToken = d.setupTokenEnv?.trim()
  if (setupToken) return setupToken
  if (d.allowClaudeCliFallback) {
    const token = await d.getCliAccessToken()
    if (token) return token
  }
  return d.allowV1AuthFallback ? d.getV1AuthAccessToken() : null
}

export function installFetchPatch(
  oauthModeActive: () => Promise<boolean>,
  getAccessToken: () => Promise<string | null>,
): () => void {
  const globals = globalThis as typeof globalThis & { [FETCH_PATCH]?: FetchPatchRecord }
  const existing = globals[FETCH_PATCH]
  const previous = existing?.active && globalThis.fetch === existing.wrapper ? existing.previous : globalThis.fetch
  if (existing) existing.active = false

  const owner = Symbol("opencode-anthropic-oauth-generation")
  const wrapper: typeof fetch = async (input, init) => {
    let url: URL
    try {
      url = new URL(input instanceof Request ? input.url : String(input))
    } catch {
      return previous(input, init)
    }
    if (url.origin !== "https://api.anthropic.com") return previous(input, init)

    const key = readHeader(input, init, "x-api-key")
    if (key !== SENTINEL_KEY && !key?.startsWith("sk-ant-oat")) return previous(input, init)
    if (!(await oauthModeActive())) return previous(input, init)

    const access = (await getAccessToken()) ?? (key?.startsWith("sk-ant-oat") ? key : null)
    if (!access) {
      throw new Error("opencode-anthropic-oauth: OAuth mode is active but no OAuth credential is available")
    }
    return oauthRequest(access, input, init, previous)
  }
  const record: FetchPatchRecord = { owner, wrapper, previous, active: true }
  globals[FETCH_PATCH] = record
  globalThis.fetch = wrapper

  return () => {
    const current = globals[FETCH_PATCH]
    if (current?.owner !== owner || !current.active || globalThis.fetch !== wrapper) return
    current.active = false
    globalThis.fetch = previous
    delete globals[FETCH_PATCH]
  }
}
