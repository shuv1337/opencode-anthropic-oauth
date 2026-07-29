/**
 * Effect-API entrypoint — OpenCode/shuvcode v2 builds from 2.0.0-alpha-3 on.
 *
 * WHY THIS EXISTS, and why `v2.ts` cannot simply be pointed at a new import:
 *
 * alpha-3 ships `@opencode-ai/plugin@2.0.0-alpha-3`, whose exports are
 * `['.', './effect', './tui', './v1', './*']` — the `/v2` subpath this
 * package's promise plugin imports is gone. Worse, the promise bridge in
 * `packages/core/src/plugin/promise.ts` wires its generic `transform` helper to
 * the agent, catalog and command domains but exposes `integration`
 * CONSUMER-ONLY (list/get/connect.key/oauth.*). There is no
 * `integration.transform` on that bridge, so a promise plugin cannot register
 * an OAuth *implementation* at all.
 *
 * That failure is silent and therefore expensive: loading the old promise
 * plugin against alpha-3 still runs setup, still binds the proxy, and the
 * `claude-pro-max` method still SHOWS UP in `GET /api/integration` — because
 * the method descriptor is plain data and survives the version bridge. Only
 * the `authorize`/`refresh` functions are dropped. The first call to
 * `POST /api/integration/anthropic/connect/oauth` then hits
 * `core/src/integration.ts` -> `implementations.get(methodID)` -> miss ->
 * `Effect.die(...)`, which surfaces as a bare HTTP 500 with an empty body and
 * nothing in the log.
 *
 * So the Effect API is not a stylistic preference here; it is the only host
 * surface that can register an OAuth method implementation. This mirrors how
 * the platform's own providers do it (`core/src/plugin/provider/openai.ts`).
 *
 * DESIGN NOTES
 *
 * - No import from `@opencode-ai/plugin`. `define` in
 *   `@opencode-ai/plugin/effect/plugin` is literally `(plugin) => plugin`, so
 *   an Effect plugin is just `{ id, effect }`. Declaring the context
 *   structurally keeps this file building against ANY alpha without chasing a
 *   package that resolves differently per host, and keeps the runtime dep set
 *   to `effect` alone.
 * - Minimal Effect surface on purpose: `sync`, `promise`, `tryPromise`,
 *   `addFinalizer`, `runPromise`. No Schedule/Stream/fork. Effect 4 is in beta
 *   and its API is still moving; every extra combinator is a version-skew
 *   liability, and this plugin has already been burned once by exactly that.
 * - `transform`/`hook` registrations are Scope-managed by the host and dispose
 *   themselves when the plugin scope closes. Only the resources this file owns
 *   outright — the loopback proxy, the global fetch patch, the refresh timer —
 *   need explicit finalizers.
 *
 * All credential precedence, option parsing and fetch-patch logic is shared
 * with the promise entrypoint via `core.ts`.
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import { Effect } from "effect"
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
import { createAuthorizationRequest, exchangeCodeForTokens, refreshTokens } from "./oauth.js"
import { startOAuthProxy, type OAuthProxy } from "./proxy.js"
import {
  getCliAccessToken,
  getV1AuthAccessToken,
  hasCliCredentials,
  hasV1OAuthEntry,
  oauthRequest,
} from "./shared.js"

/** How often the catalog is re-checked for an OAuth-mode flip. The catalog
 *  transform is synchronous and cannot await credential state, so the mode is
 *  cached and the catalog is reloaded when it changes. Connecting or removing
 *  a credential is a human-scale event; a few seconds of lag is invisible and
 *  costs one in-memory comparison. */
const MODE_POLL_MS = 4_000

/** Delay before the first check. The host is still activating sibling plugins
 *  during setup, and a catalog reload issued in that window deadlocks
 *  activation — the same hazard the promise entrypoint guards against. */
const MODE_POLL_DELAY_MS = 1_000

// --------------------------------------------------------------- host types
// Structural only — see DESIGN NOTES. These mirror
// packages/plugin/src/effect/{plugin,integration,catalog,aisdk,registration}.ts
// at 2.0.0-alpha-3, narrowed to what this plugin actually touches.

interface Registration {
  readonly dispose: Effect.Effect<void>
}
type Transform<Draft> = (callback: (draft: Draft) => void) => Effect.Effect<Registration, never, never>

interface OAuthCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly access: string
  readonly refresh: string
  readonly expires?: number
}

interface IntegrationDraft {
  readonly method: {
    list(integrationID: string): readonly { readonly type: string }[]
    update(input: {
      readonly integrationID: string
      readonly method: { readonly type: "key" } | { readonly type: "env"; readonly names: readonly string[] }
    }): void
    update(input: {
      readonly integrationID: string
      readonly method: { readonly id: string; readonly type: "oauth"; readonly label?: string }
      readonly authorize: (inputs: Record<string, string>) => Effect.Effect<
        {
          readonly mode: "code"
          readonly url: string
          readonly instructions: string
          readonly expiresAt?: number
          readonly callback: (code: string) => Effect.Effect<OAuthCredential, unknown>
        },
        unknown,
        never
      >
      readonly refresh?: (credential: OAuthCredential) => Effect.Effect<OAuthCredential, unknown>
    }): void
  }
}

interface CatalogProviderRecord {
  readonly provider: { settings?: Record<string, any>; body?: Record<string, any> }
  readonly models: ReadonlyMap<string, { id: string }>
}

interface CatalogDraft {
  readonly provider: {
    get(providerID: string): CatalogProviderRecord | undefined
    update(providerID: string, update: (provider: { settings?: Record<string, any>; body?: Record<string, any> }) => void): void
  }
  readonly model: {
    update(
      providerID: string,
      modelID: string,
      update: (model: { cost?: unknown; settings?: Record<string, any> }) => void,
    ): void
  }
}

interface ConnectionInfo {
  readonly id: string
}

interface PluginContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly integration: {
    readonly transform: Transform<IntegrationDraft>
    readonly connection: {
      readonly active: (integrationID: string) => Effect.Effect<ConnectionInfo | undefined>
      readonly resolve: (
        connection: ConnectionInfo,
      ) => Effect.Effect<{ type?: string; access?: string; key?: string } | undefined, unknown>
    }
  }
  readonly catalog: {
    readonly transform: Transform<CatalogDraft>
    readonly reload: () => Effect.Effect<void>
  }
  readonly aisdk: {
    readonly hook: (
      name: "sdk",
      callback: (input: {
        readonly model: { providerID: string }
        readonly package: string
        readonly options: Record<string, any>
        sdk?: any
      }) => Effect.Effect<void>,
    ) => Effect.Effect<Registration, never, never>
  }
}

// ------------------------------------------------------------------- plugin

export default {
  id: "opencode-anthropic-oauth",
  effect: Effect.fn(function* (ctx: PluginContext) {
    debug("v3 setup started")
    const options = parseV2Options(ctx.options)

    // Credential lookups cross into promise-land because the shared precedence
    // helpers in core.ts are host-agnostic and promise-based. These Effects
    // carry no context requirement, so running them standalone is safe.
    const activeCredential = async () => {
      const connection = await Effect.runPromise(ctx.integration.connection.active(INTEGRATION_ID))
      if (!connection) return undefined
      return await Effect.runPromise(
        ctx.integration.connection.resolve(connection).pipe(Effect.catch(() => Effect.succeed(undefined))),
      )
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

    // --- OAuth method registration. THE reason this entrypoint exists.
    yield* ctx.integration.transform((draft) => {
      // Registering a method on an integration the draft has not seeded yet
      // makes the host mint a fresh entry whose `methods` array contains only
      // what we add (core/src/integration.ts, draft.method.update). The
      // built-in `key`/`env` methods then exist for display but not in the
      // transformed state that `connection.key` consults — so connecting an
      // API key to Anthropic would start dying with a bare 500 purely because
      // this plugin is installed. Re-declare them so we extend the integration
      // instead of shadowing it.
      const existing = draft.method.list(INTEGRATION_ID)
      if (!existing.some((method) => method.type === "key")) {
        draft.method.update({ integrationID: INTEGRATION_ID, method: { type: "key" } })
      }
      if (!existing.some((method) => method.type === "env")) {
        draft.method.update({
          integrationID: INTEGRATION_ID,
          method: { type: "env", names: ["ANTHROPIC_API_KEY"] },
        })
      }
      draft.method.update({
        integrationID: INTEGRATION_ID,
        method: { id: METHOD_ID, type: "oauth", label: "Claude Pro/Max" },
        authorize: () =>
          Effect.sync(() => {
            const { url, verifier } = createAuthorizationRequest()
            return {
              mode: "code" as const,
              url,
              instructions: "Authenticate with Claude, then paste the returned authorization code.",
              callback: (code: string) =>
                Effect.tryPromise({
                  try: async () => {
                    const tokens = await exchangeCodeForTokens(code, verifier)
                    return { type: "oauth" as const, methodID: METHOD_ID, ...tokens }
                  },
                  catch: () => new Error("Claude OAuth authorization failed"),
                }),
            }
          }),
        refresh: (credential) =>
          Effect.tryPromise({
            try: async () => ({ ...credential, ...(await refreshTokens(credential.refresh)) }),
            catch: () => new Error("Claude OAuth refresh failed"),
          }),
      })
    })
    debug("v3 integration method registered")

    // --- Loopback proxy. The native Anthropic route resolves its `fetch` before
    // plugins load and always sends the credential as `x-api-key`, so a global
    // patch alone can no longer intercept it; the provider baseURL is pointed
    // at a local proxy that rewrites the call into a subscription request.
    const originalFetch = globalThis.fetch.bind(globalThis)
    let proxy: OAuthProxy | undefined
    let proxyBaseURL: string | undefined
    proxy = yield* Effect.promise(() => startOAuthProxy({ getAccessToken, fetchImpl: originalFetch })).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    )
    if (proxy) {
      // The route uses a versioned base and a bare `/messages` path, so the
      // override must carry `/v1` for the request to reconstruct correctly.
      proxyBaseURL = `${proxy.url}/v1`
      debug(`v3 oauth proxy listening at ${proxy.url}`)
      const owned = proxy
      yield* Effect.addFinalizer(() => Effect.promise(() => owned.close().catch(() => {})))
    } else {
      debug("v3 oauth proxy failed to start")
    }

    // Connection APIs are not re-entrant while setup is activating, so seed
    // from local opt-in sources only and resolve stored state on the timer.
    let oauthEnabled =
      !process.env.ANTHROPIC_API_KEY?.trim() &&
      (!!process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
        (options.allowClaudeCliFallback && hasCliCredentials()) ||
        (options.allowV1AuthFallback && hasV1OAuthEntry()))

    yield* ctx.catalog.transform((draft) => {
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
          if (proxyBaseURL) {
            candidate.settings ??= {}
            candidate.settings.baseURL = proxyBaseURL
          }
        })
      }
    })
    debug("v3 catalog transform registered")

    yield* ctx.aisdk.hook("sdk", (event) =>
      Effect.promise(async () => {
        if (event.package !== "@ai-sdk/anthropic" || event.model.providerID !== INTEGRATION_ID) return
        if (!(await oauthModeActive())) return
        event.options.apiKey = ""
        event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
          const access = await getAccessToken()
          if (!access) throw new Error("opencode-anthropic-oauth: no OAuth credential is available")
          return oauthRequest(access, input, init)
        }
        event.sdk = createAnthropic(event.options)
      }),
    )
    debug("v3 AI SDK hook registered")

    const removeFetchPatch = installFetchPatch(oauthModeActive, getAccessToken)
    yield* Effect.addFinalizer(() => Effect.sync(removeFetchPatch))
    debug("v3 fetch patch installed")

    // --- Mode refresh. Plain timers rather than a forked Effect fiber: see
    // DESIGN NOTES on keeping the Effect surface minimal.
    let timer: ReturnType<typeof setInterval> | undefined
    const refreshCatalogMode = async () => {
      const next = await oauthModeActive().catch(() => oauthEnabled)
      if (next === oauthEnabled) return
      oauthEnabled = next
      debug(`v3 oauth mode -> ${next}, reloading catalog`)
      await Effect.runPromise(ctx.catalog.reload()).catch(() => {})
    }
    const start = setTimeout(() => {
      void refreshCatalogMode().catch(() => {})
      timer = setInterval(() => void refreshCatalogMode().catch(() => {}), MODE_POLL_MS)
      timer.unref?.()
    }, MODE_POLL_DELAY_MS)
    start.unref?.()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearTimeout(start)
        if (timer) clearInterval(timer)
      }),
    )

    debug("v3 setup complete")
  }),
}
