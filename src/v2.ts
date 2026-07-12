import { createAnthropic } from "@ai-sdk/anthropic"
import { Plugin } from "@opencode-ai/plugin/v2"
import { Effect } from "effect"
import { createAuthorizationRequest, exchangeCodeForTokens, refreshTokens } from "./oauth.js"
import { startOAuthProxy, type OAuthProxy } from "./proxy.js"
import {
  getCliAccessToken,
  getV1AuthAccessToken,
  hasCliCredentials,
  hasV1OAuthEntry,
  oauthRequest,
} from "./shared.js"

const INTEGRATION_ID = "anthropic"
const METHOD_ID = "claude-pro-max"
export const SENTINEL_KEY = "opencode-anthropic-oauth"

interface V2Options {
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
const debug = (message: string) => {
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
 *   3. Claude CLI / V1 auth.json only apply when their opt-in flags are set.
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
  return (d.allowClaudeCliFallback && d.hasCliCredentials())
    || (d.allowV1AuthFallback && d.hasV1OAuthEntry())
}

/**
 * Resolve the OAuth access token to authorize a request with, honouring the
 * same precedence as `isOauthModeActive`. Returns null for API-key modes and
 * when no OAuth credential is available.
 */
export async function resolveAccessToken(d: CredentialResolution): Promise<string | null> {
  try {
    const credential = await d.activeCredential()
    if (credential?.type === "key") return null
    if (credential?.type === "oauth") return credential.access ?? null
  } catch {
    // Continue only through explicitly enabled isolated fallbacks.
  }
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

export default Plugin.define({
  id: "opencode-anthropic-oauth",
  setup: async (ctx) => {
    debug("setup started")
    const options = parseV2Options(ctx.options)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const events = new AbortController()

    registrations.push(await ctx.integration.transform((draft) => {
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Claude Pro/Max" },
        authorize: () => Effect.sync(() => {
          const { url, verifier } = createAuthorizationRequest()
          return {
            mode: "code" as const,
            url,
            instructions: "Authenticate with Claude, then paste the returned authorization code.",
            callback: (code: string) => Effect.tryPromise({
              try: async () => {
                const tokens = await exchangeCodeForTokens(code, verifier)
                return { type: "oauth" as const, methodID: METHOD_ID, ...tokens }
              },
              catch: () => new Error("Claude OAuth authorization failed"),
            }),
          }
        }),
        refresh: (credential) => Effect.tryPromise({
          try: async () => ({ ...credential, ...await refreshTokens(credential.refresh) }),
          catch: () => new Error("Claude OAuth refresh failed"),
        }),
      })
    }))
    debug("integration transform registered")

    const activeCredential = async () => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      return connection ? await ctx.integration.connection.resolve(connection) : undefined
    }

    const resolution = (): CredentialResolution => ({
      apiKeyEnv: process.env.ANTHROPIC_API_KEY,
      activeCredential,
      allowClaudeCliFallback: options.allowClaudeCliFallback,
      allowV1AuthFallback: options.allowV1AuthFallback,
      hasCliCredentials,
      hasV1OAuthEntry,
      getCliAccessToken,
      getV1AuthAccessToken,
    })

    const oauthModeActive = (): Promise<boolean> => isOauthModeActive(resolution())
    const getAccessToken = (): Promise<string | null> => resolveAccessToken(resolution())

    // Recent OpenCode builds dispatch the native Anthropic route through an
    // Effect HttpClient whose `fetch` reference is frozen before plugins load,
    // and always send the credential as `x-api-key`. A global fetch patch can
    // no longer intercept it. Redirect the provider's `baseURL` to a loopback
    // proxy that rewrites the request into a Claude Pro/Max subscription call.
    const originalFetch = globalThis.fetch.bind(globalThis)
    let proxy: OAuthProxy | undefined
    // OpenCode's Anthropic route uses the versioned base `.../v1` and a bare
    // `/messages` path, so the override base must also carry `/v1` for the
    // request to reconstruct as `/v1/messages`. The proxy forwards the full
    // incoming path to `https://api.anthropic.com`.
    let proxyBaseURL: string | undefined
    try {
      proxy = await startOAuthProxy({ getAccessToken, fetchImpl: originalFetch })
      proxyBaseURL = `${proxy.url}/v1`
      debug(`oauth proxy listening at ${proxy.url}`)
    } catch (error) {
      debug(`oauth proxy failed to start: ${error instanceof Error ? error.message : String(error)}`)
    }

    // Connection APIs are not re-entrant while plugin setup is activating.
    // Seed only from local opt-in sources, then resolve stored V2 state after
    // setup has returned to the host.
    let oauthEnabled = !process.env.ANTHROPIC_API_KEY?.trim() && (
      (options.allowClaudeCliFallback && hasCliCredentials())
      || (options.allowV1AuthFallback && hasV1OAuthEntry())
    )
    registrations.push(await ctx.catalog.transform((draft) => {
      if (!oauthEnabled) return
      const item = draft.provider.get(INTEGRATION_ID)
      if (!item) return
      draft.provider.update(INTEGRATION_ID, (provider) => {
        provider.body ??= {}
        if (typeof provider.body.apiKey !== "string" || !provider.body.apiKey) provider.body.apiKey = SENTINEL_KEY
        if (proxyBaseURL) {
          provider.settings ??= {}
          provider.settings.baseURL = proxyBaseURL
        }
      })
      for (const model of item.models.values()) {
        draft.model.update(INTEGRATION_ID, model.id, (candidate) => {
          candidate.cost = []
          // Route this model through the loopback proxy. `model.settings.baseURL`
          // is what the request runner reads to override the endpoint host.
          if (proxyBaseURL) {
            candidate.settings ??= {}
            candidate.settings.baseURL = proxyBaseURL
          }
        })
      }
    }))
    debug("catalog transform registered")

    registrations.push(await ctx.aisdk.hook("sdk", async (event) => {
      if (event.package !== "@ai-sdk/anthropic" || event.model.providerID !== INTEGRATION_ID) return
      if (!(await oauthModeActive())) return
      event.options.apiKey = ""
      event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const access = await getAccessToken()
        if (!access) throw new Error("opencode-anthropic-oauth: no OAuth credential is available")
        return oauthRequest(access, input, init)
      }
      event.sdk = createAnthropic(event.options)
    }))
    debug("AI SDK hook registered")

    const removeFetchPatch = installFetchPatch(oauthModeActive, getAccessToken)
    debug("fetch patch installed")
    const refreshCatalogMode = async () => {
      const next = await oauthModeActive()
      if (next === oauthEnabled) return
      oauthEnabled = next
      await ctx.catalog.reload()
    }
    const bootstrapTask = new Promise<void>((resolve) => {
      // Let the host finish activating every configured plugin before a
      // catalog replay; reloading during sibling setup deadlocks activation.
      setTimeout(() => void refreshCatalogMode().catch(() => {}).finally(resolve), 1_000)
    })
    const eventTask = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type !== "integration.connection.updated") continue
          const data = event.data as { integrationID?: string }
          if (data.integrationID && data.integrationID !== INTEGRATION_ID) continue
          await refreshCatalogMode()
        }
      } catch {
        // Abort and transient event-stream failures do not affect model requests.
      }
    })()

    return async () => {
      debug("cleanup started")
      events.abort()
      removeFetchPatch()
      if (proxy) await proxy.close().catch(() => {})
      await Promise.allSettled(registrations.map((registration) => registration.dispose()))
      await Promise.race([Promise.allSettled([bootstrapTask, eventTask]), new Promise((resolve) => setTimeout(resolve, 1_000))])
    }
  },
})
