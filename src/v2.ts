import { createAnthropic } from "@ai-sdk/anthropic"
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

import {
  INTEGRATION_ID,
  METHOD_ID,
  SENTINEL_KEY,
  debug,
  installFetchPatch,
  isOauthModeActive,
  parseV2Options,
  resolveAccessToken,
  type CredentialResolution,
} from "./core.js"

// Re-exported so existing importers and the test-suite keep their entrypoint.
export {
  SENTINEL_KEY,
  parseV2Options,
  isOauthModeActive,
  resolveAccessToken,
  installFetchPatch,
  type CredentialResolution,
}


/** Structural host context for the LEGACY promise API (builds up to
 *  `@opencode-ai/plugin@0.0.0-next-15353`). Declared locally rather than
 *  imported: that package's types are pinned to `effect@4.0.0-beta.83`, and
 *  this package now builds against `effect@4.0.0-beta.101` to match
 *  shuvcode 2.0.0-alpha-3 (see v3.ts). Its `Plugin.define` was verified to be
 *  `(plugin) => plugin`, so exporting the object literal is equivalent.
 *
 *  Deliberately loose: this entrypoint exists only for hosts that predate the
 *  Effect plugin API, and precise draft typing there earns nothing. */
interface LegacyPluginContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly integration: any
  readonly catalog: any
  readonly aisdk: any
  readonly event: any
}

export default {
  id: "opencode-anthropic-oauth",
  setup: async (ctx: LegacyPluginContext) => {
    debug("setup started")
    const options = parseV2Options(ctx.options)
    const registrations: Array<{ dispose(): Promise<void> }> = []
    const events = new AbortController()

    registrations.push(await ctx.integration.transform((draft: any) => {
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
        refresh: (credential: any) => Effect.tryPromise({
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
      setupTokenEnv: process.env.CLAUDE_CODE_OAUTH_TOKEN,
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
    registrations.push(await ctx.catalog.transform((draft: any) => {
      if (!oauthEnabled) return
      const item = draft.provider.get(INTEGRATION_ID)
      if (!item) return
      draft.provider.update(INTEGRATION_ID, (provider: any) => {
        provider.body ??= {}
        if (typeof provider.body.apiKey !== "string" || !provider.body.apiKey) provider.body.apiKey = SENTINEL_KEY
        if (proxyBaseURL) {
          provider.settings ??= {}
          provider.settings.baseURL = proxyBaseURL
        }
      })
      for (const model of item.models.values() as Iterable<{ id: string }>) {
        draft.model.update(INTEGRATION_ID, model.id, (candidate: any) => {
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

    registrations.push(await ctx.aisdk.hook("sdk", async (event: any) => {
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
}
