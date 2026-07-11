import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

// Isolate HOME so the V1 loader's getCliAccessToken() finds no Claude CLI
// credentials and exercises the plugin's own OAuth refresh path.
const sandbox = mkdtempSync(path.join(tmpdir(), "anthropic-oauth-v1loader-"))
process.env.HOME = sandbox
process.env.XDG_DATA_HOME = path.join(sandbox, "xdg")

const v1plugin = (await import("../dist/index.js")).default

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MESSAGES_URL = "https://api.anthropic.com/v1/messages"

// A fetch stub that distinguishes the token endpoint (refresh) from the
// Anthropic request endpoint, counting refreshes and recording request auth.
function installFetchStub() {
  const state = { refreshCalls: 0, requestAuths: [] }
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const u = String(url instanceof Request ? url.url : url)
    if (u.includes("/oauth/token")) {
      state.refreshCalls++
      await sleep(15)
      return Response.json({ access_token: `fresh-${state.refreshCalls}`, refresh_token: "rotated", expires_in: 3600 })
    }
    state.requestAuths.push(new Headers(init.headers).get("authorization"))
    return new Response("data: {}\r\n\r\n", { headers: { "content-type": "text/event-stream" } })
  }
  return { state, restore: () => { globalThis.fetch = original } }
}

test("V1 loader coalesces concurrent expired-token refreshes into one call", async () => {
  const api = await v1plugin({ client: { auth: { set: async () => {} } } })
  const expiredAuth = { type: "oauth", access: "", refresh: "r", expires: Date.now() - 1000 }
  // Install the stub before loader() so the proactive refresh it may trigger
  // is mocked (never a real network call) and shares the single-flight guard.
  const stub = installFetchStub()
  try {
    const loaded = await api.auth.loader(async () => expiredAuth, { models: { m: { cost: {} } } })
    const requests = Array.from({ length: 4 }, () =>
      loaded.fetch(MESSAGES_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
    await Promise.all(requests)
    assert.equal(stub.state.refreshCalls, 1, "exactly one refresh across the concurrent burst")
    // Every request carried the same freshly refreshed bearer token.
    assert.deepEqual(new Set(stub.state.requestAuths), new Set(["Bearer fresh-1"]))
    assert.equal(stub.state.requestAuths.length, 4)
  } finally {
    stub.restore()
  }
})

test("V1 loader refreshes at dispatch when a token valid at load time has expired", async () => {
  const api = await v1plugin({ client: { auth: { set: async () => {} } } })
  // Valid at loader/catalog time: no refresh should occur during loader().
  let authState = { type: "oauth", access: "valid-access", refresh: "r", expires: Date.now() + 3600_000 }
  const provider = { models: { m: { cost: { input: 5, output: 5 } } } }
  const stub = installFetchStub()
  try {
    const loaded = await api.auth.loader(async () => authState, provider)
    // Loader zeroes cost for the Pro/Max subscription, and the still-valid
    // token means no proactive refresh fired.
    assert.deepEqual(provider.models.m.cost, { input: 0, output: 0, cache: { read: 0, write: 0 } })
    assert.equal(stub.state.refreshCalls, 0)

    // Token has since expired by dispatch time -> refresh must happen now.
    authState = { type: "oauth", access: "valid-access", refresh: "r", expires: Date.now() - 1000 }
    await loaded.fetch(MESSAGES_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
    assert.equal(stub.state.refreshCalls, 1)
    assert.deepEqual(stub.state.requestAuths, ["Bearer fresh-1"])
  } finally {
    stub.restore()
  }
})
