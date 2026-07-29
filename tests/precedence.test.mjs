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

// --- CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) -------------------------
// The browserless OAuth source. A headless daemon cannot create an interactive
// attempt, so this is the only way such a host reaches a Pro/Max subscription.

test("setup token enables OAuth and resolves as the access token", async () => {
  const d = deps({ setupTokenEnv: "sk-ant-oat01-example" })
  assert.equal(await isOauthModeActive(d), true)
  assert.equal(await resolveAccessToken(d), "sk-ant-oat01-example")
})

test("an explicit API key still beats a setup token", async () => {
  const d = deps({ apiKeyEnv: "sk-ant-api-xyz", setupTokenEnv: "sk-ant-oat01-example" })
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})

test("a stored key credential still beats a setup token", async () => {
  const d = deps({ activeCredential: async () => ({ type: "key" }), setupTokenEnv: "sk-ant-oat01-example" })
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})

test("an interactively connected account outranks an ambient setup token", async () => {
  const d = deps({
    activeCredential: async () => ({ type: "oauth", access: "connected-token" }),
    setupTokenEnv: "sk-ant-oat01-example",
  })
  assert.equal(await isOauthModeActive(d), true)
  assert.equal(await resolveAccessToken(d), "connected-token")
})

test("setup token outranks the opt-in CLI fallback", async () => {
  const d = deps({
    setupTokenEnv: "sk-ant-oat01-example",
    allowClaudeCliFallback: true,
    hasCliCredentials: () => true,
    getCliAccessToken: async () => "cli-token",
  })
  assert.equal(await resolveAccessToken(d), "sk-ant-oat01-example")
})

test("blank or whitespace setup token is ignored", async () => {
  const d = deps({ setupTokenEnv: "   " })
  assert.equal(await isOauthModeActive(d), false)
  assert.equal(await resolveAccessToken(d), null)
})

test("setup token still applies when a stored connection lookup throws", async () => {
  const d = deps({
    setupTokenEnv: "sk-ant-oat01-example",
    activeCredential: async () => {
      throw new Error("host not ready")
    },
  })
  assert.equal(await isOauthModeActive(d), true)
  assert.equal(await resolveAccessToken(d), "sk-ant-oat01-example")
})
