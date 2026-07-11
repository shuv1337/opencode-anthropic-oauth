import assert from "node:assert/strict"
import test from "node:test"
import { isOauthModeActive, resolveAccessToken } from "../dist/v2.js"

// Fully injected credential sources — no real files, env, or network.
function deps(overrides = {}) {
  return {
    apiKeyEnv: undefined,
    activeCredential: async () => undefined,
    allowClaudeCliFallback: false,
    allowV1AuthFallback: false,
    hasCliCredentials: () => false,
    hasV1OAuthEntry: () => false,
    getCliAccessToken: async () => null,
    getV1AuthAccessToken: async () => null,
    ...overrides,
  }
}

test("no credentials: OAuth inactive and no token resolved", async () => {
  const d = deps()
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})

test("explicit V2 API key credential disables OAuth interception", async () => {
  const d = deps({ activeCredential: async () => ({ type: "key" }) })
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})

test("environment API key always disables OAuth even with an OAuth connection present", async () => {
  const d = deps({
    apiKeyEnv: "sk-ant-api-xyz",
    activeCredential: async () => ({ type: "oauth", access: "oauth-token" }),
    allowClaudeCliFallback: true,
    hasCliCredentials: () => true,
  })
  assert.equal(await isOauthModeActive(d), false)
})

test("whitespace-only environment API key does not count as an explicit key", async () => {
  const d = deps({
    apiKeyEnv: "   ",
    activeCredential: async () => ({ type: "oauth", access: "oauth-token" }),
  })
  assert.equal(await isOauthModeActive(d), true)
})

test("V2 OAuth connection activates OAuth and yields its access token", async () => {
  const d = deps({ activeCredential: async () => ({ type: "oauth", access: "oauth-token" }) })
  assert.equal(await isOauthModeActive(d), true)
  assert.equal(await resolveAccessToken(d), "oauth-token")
})

test("Claude CLI fallback only applies when opted in", async () => {
  const off = deps({ hasCliCredentials: () => true, getCliAccessToken: async () => "cli-token" })
  assert.equal(await isOauthModeActive(off), false)
  assert.equal(await resolveAccessToken(off), null)

  const on = deps({
    allowClaudeCliFallback: true,
    hasCliCredentials: () => true,
    getCliAccessToken: async () => "cli-token",
  })
  assert.equal(await isOauthModeActive(on), true)
  assert.equal(await resolveAccessToken(on), "cli-token")
})

test("V1 auth.json fallback only applies when opted in", async () => {
  const off = deps({ hasV1OAuthEntry: () => true, getV1AuthAccessToken: async () => "v1-token" })
  assert.equal(await isOauthModeActive(off), false)
  assert.equal(await resolveAccessToken(off), null)

  const on = deps({
    allowV1AuthFallback: true,
    hasV1OAuthEntry: () => true,
    getV1AuthAccessToken: async () => "v1-token",
  })
  assert.equal(await isOauthModeActive(on), true)
  assert.equal(await resolveAccessToken(on), "v1-token")
})

test("CLI fallback wins over V1 fallback when both are enabled", async () => {
  const d = deps({
    allowClaudeCliFallback: true,
    allowV1AuthFallback: true,
    hasCliCredentials: () => true,
    hasV1OAuthEntry: () => true,
    getCliAccessToken: async () => "cli-token",
    getV1AuthAccessToken: async () => "v1-token",
  })
  assert.equal(await resolveAccessToken(d), "cli-token")
})

test("falls through to V1 fallback when CLI yields no token", async () => {
  const d = deps({
    allowClaudeCliFallback: true,
    allowV1AuthFallback: true,
    getCliAccessToken: async () => null,
    getV1AuthAccessToken: async () => "v1-token",
  })
  assert.equal(await resolveAccessToken(d), "v1-token")
})

test("a failing connection resolve does not throw and falls back to opt-in sources", async () => {
  const d = deps({
    activeCredential: async () => {
      throw new Error("resolve exploded")
    },
    allowClaudeCliFallback: true,
    hasCliCredentials: () => true,
    getCliAccessToken: async () => "cli-token",
  })
  assert.equal(await isOauthModeActive(d), true)
  assert.equal(await resolveAccessToken(d), "cli-token")
})

test("explicit API-key credential is never overridden by enabled fallbacks", async () => {
  const d = deps({
    activeCredential: async () => ({ type: "key" }),
    allowClaudeCliFallback: true,
    allowV1AuthFallback: true,
    hasCliCredentials: () => true,
    hasV1OAuthEntry: () => true,
    getCliAccessToken: async () => "cli-token",
    getV1AuthAccessToken: async () => "v1-token",
  })
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})
