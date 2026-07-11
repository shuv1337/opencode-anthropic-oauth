import assert from "node:assert/strict"
import test from "node:test"
import v1plugin from "../dist/index.js"
import { refreshTokens } from "../dist/oauth.js"
import { oauthRequest } from "../dist/shared.js"
import v2plugin, { SENTINEL_KEY } from "../dist/v2.js"
import { makeMockCtx } from "./mock-ctx.mjs"

// Distinctive secrets that must never reach any log sink.
const SECRET_ACCESS = "SECRET-ACCESS-TOKEN-a1b2c3d4e5f6"
const SECRET_REFRESH = "SECRET-REFRESH-TOKEN-z9y8x7w6v5"
const ROTATED_ACCESS = "SECRET-ROTATED-ACCESS-0f1e2d3c"
const ROTATED_REFRESH = "SECRET-ROTATED-REFRESH-4b5a6978"
const SECRETS = [SECRET_ACCESS, SECRET_REFRESH, ROTATED_ACCESS, ROTATED_REFRESH]

function captureConsole() {
  const lines = []
  const record = (...args) => lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
  const methods = ["log", "error", "warn", "info", "debug"]
  const originals = {}
  for (const m of methods) {
    originals[m] = console[m]
    console[m] = record
  }
  return {
    lines,
    restore() {
      for (const m of methods) console[m] = originals[m]
    },
  }
}

function assertNoSecrets(lines) {
  const blob = lines.join("\n")
  for (const secret of SECRETS) assert.doesNotMatch(blob, new RegExp(secret))
  // Bearer/authorization header values must never be logged either.
  assert.doesNotMatch(blob, /Bearer\s+\S/)
  assert.doesNotMatch(blob, /authorization/i)
}

test("debug logging never leaks credentials during token resolution, refresh, or interception", async () => {
  process.env.OPENCODE_ANTHROPIC_OAUTH_DEBUG = "1"
  const capture = captureConsole()
  const originalFetch = globalThis.fetch
  try {
    // 1. Full V2 setup + a live credential resolution with debug enabled.
    const { ctx, state } = makeMockCtx({
      credential: { type: "oauth", access: SECRET_ACCESS, refresh: SECRET_REFRESH, expires: Date.now() + 3600_000 },
    })
    const cleanup = await v2plugin.setup(ctx)

    // 2. Token resolution + request interception through the installed patch.
    globalThis.fetch = async () => new Response("ok")
    await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
      body: "{}",
    })
    void state

    // 3. Direct request interception (Bearer header applied here).
    await oauthRequest(SECRET_ACCESS, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }, async () => new Response("ok"))

    // 4. Token refresh with rotation of both tokens.
    globalThis.fetch = async () =>
      Response.json({ access_token: ROTATED_ACCESS, refresh_token: ROTATED_REFRESH, expires_in: 3600 })
    await refreshTokens(SECRET_REFRESH)

    await cleanup()
  } finally {
    globalThis.fetch = originalFetch
    capture.restore()
    delete process.env.OPENCODE_ANTHROPIC_OAUTH_DEBUG
  }
  assertNoSecrets(capture.lines)
})

test("V1 token-exchange failure logging excludes tokens and response bodies", async () => {
  const capture = captureConsole()
  const originalFetch = globalThis.fetch
  try {
    const api = await v1plugin({ client: { auth: { set: async () => {} } } })
    const method = api.auth.methods[0]
    const flow = await method.authorize()
    globalThis.fetch = async () => new Response("secret-server-body-with-token-material", { status: 401 })
    const result = await flow.callback("bad-code")
    assert.equal(result.type, "failed")
  } finally {
    globalThis.fetch = originalFetch
    capture.restore()
  }
  const blob = capture.lines.join("\n")
  assert.doesNotMatch(blob, /secret-server-body-with-token-material/)
  assert.doesNotMatch(blob, /Bearer\s+\S/)
})
