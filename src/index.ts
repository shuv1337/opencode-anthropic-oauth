import type { Plugin } from "@opencode-ai/plugin"
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  refreshTokens,
} from "./oauth.js"
import { getCliAccessToken, oauthRequest } from "./shared.js"

// --- Constants ---
const REFRESH_INTERVAL = 5 * 60 * 1000
const REFRESH_BUFFER = 10 * 60 * 1000

// --- v1 plugin ---
const plugin: Plugin = async ({ client }) => {
  let _getAuth: (() => Promise<any>) | null = null
  // Single-flight guard: a burst of concurrent expired requests (plus the
  // proactive timer) must trigger exactly one token endpoint call, otherwise
  // each refresh races the others over the same rotating refresh token.
  let refreshInFlight: Promise<{ access: string; refresh: string; expires: number }> | null = null

  async function refreshAndPersist(refresh: string) {
    if (!refreshInFlight) {
      refreshInFlight = refreshTokens(refresh)
        .then(async (fresh) => {
          await client.auth.set({
            path: { id: "anthropic" },
            body: {
              type: "oauth",
              refresh: fresh.refresh,
              access: fresh.access,
              expires: fresh.expires,
            },
          })
          return fresh
        })
        .finally(() => {
          refreshInFlight = null
        })
    }
    return refreshInFlight
  }

  async function proactiveRefresh() {
    if (!_getAuth) return
    try {
      const auth = await _getAuth()
      if (!auth || auth.type !== "oauth" || !auth.refresh) return
      if (auth.expires > Date.now() + REFRESH_BUFFER) return
      await refreshAndPersist(auth.refresh)
    } catch {
      // Non-fatal
    }
  }

  const refreshTimer = setInterval(() => proactiveRefresh(), REFRESH_INTERVAL)
  refreshTimer.unref()

  return {
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if ((auth as any).type !== "oauth") return {}

        _getAuth = getAuth
        proactiveRefresh()

        // Zero out cost for Pro/Max subscription
        for (const model of Object.values(provider.models)) {
          ;(model as any).cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const auth = (await getAuth()) as any
            if (auth.type !== "oauth") return fetch(input, init)

            // Prefer Claude CLI credentials (first-party, Max plan)
            let access = await getCliAccessToken()

            // Fallback to plugin's own OAuth tokens
            if (!access) {
              access = auth.access as string
              if (!access || auth.expires < Date.now()) {
                try {
                  const fresh = await refreshAndPersist(auth.refresh)
                  access = fresh.access
                } catch (err) {
                  throw new Error(
                    `Token refresh failed: ${err instanceof Error ? err.message : err}`,
                  )
                }
              }
            }

            return oauthRequest(access, input, init)
          },
        }
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Claude Pro/Max",
          authorize() {
            const { url, verifier } = createAuthorizationRequest()

            return Promise.resolve({
              url,
              instructions:
                "Open the link above to authenticate with your Claude account. " +
                "After authorizing, you'll receive a code — paste it below.",
              method: "code" as const,
              async callback(code: string) {
                try {
                  const tokens = await exchangeCodeForTokens(code, verifier)
                  return {
                    type: "success" as const,
                    access: tokens.access,
                    refresh: tokens.refresh,
                    expires: tokens.expires,
                  }
                } catch (err) {
                  console.error(
                    "opencode-anthropic-oauth: token exchange failed:",
                    err instanceof Error ? err.message : err,
                  )
                  return { type: "failed" as const }
                }
              },
            })
          },
        },
      ],
    },
  }
}

export default plugin
