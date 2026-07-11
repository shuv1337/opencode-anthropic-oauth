import assert from "node:assert/strict"
import test from "node:test"
import plugin, { installFetchPatch, parseV2Options, SENTINEL_KEY } from "../dist/v2.js"

test("V2 package exports the stable plugin ID and validates fallback options", () => {
  assert.equal(plugin.id, "opencode-anthropic-oauth")
  assert.deepEqual(parseV2Options({}), { allowClaudeCliFallback: false, allowV1AuthFallback: false })
  assert.throws(() => parseV2Options({ allowV1AuthFallback: "yes" }), /boolean/)
})

test("fetch patch is narrow, reversible, and API-key safe", async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response("ok")
  }
  const base = globalThis.fetch
  const cleanup = installFetchPatch(async () => true, async () => "oauth-access")
  try {
    await fetch("https://example.com/test")
    await fetch("https://api.anthropic.com/v1/messages", { headers: { "x-api-key": "sk-ant-api-real" } })
    await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
      body: "{}",
    })
    assert.equal(calls.length, 3)
    assert.equal(calls[2].init.headers.get("authorization"), "Bearer oauth-access")
    assert.equal(calls[2].init.headers.get("x-api-key"), null)
  } finally {
    cleanup()
    assert.equal(globalThis.fetch, base)
    globalThis.fetch = original
  }
})

test("new fetch generations do not stack and old cleanup cannot remove the owner", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("ok")
  const base = globalThis.fetch
  const cleanup1 = installFetchPatch(async () => false, async () => null)
  const wrapper1 = globalThis.fetch
  const cleanup2 = installFetchPatch(async () => false, async () => null)
  const wrapper2 = globalThis.fetch
  assert.notEqual(wrapper1, wrapper2)
  cleanup1()
  assert.equal(globalThis.fetch, wrapper2)
  cleanup2()
  assert.equal(globalThis.fetch, base)
  globalThis.fetch = original
})
