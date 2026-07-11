import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

// Isolate HOME/XDG *before* importing the module so every credential read/write
// targets this throwaway sandbox — never the real user's credential files.
const sandbox = mkdtempSync(path.join(tmpdir(), "anthropic-oauth-concurrency-"))
process.env.HOME = sandbox
process.env.XDG_DATA_HOME = path.join(sandbox, "xdg")
mkdirSync(path.join(sandbox, ".claude"), { recursive: true })
mkdirSync(path.join(sandbox, "xdg", "opencode"), { recursive: true })

const { getCliAccessToken, getV1AuthAccessToken } = await import("../dist/shared.js")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test("getCliAccessToken coalesces concurrent expired refreshes into a single call", async () => {
  writeFileSync(
    path.join(sandbox, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "expired", refreshToken: "cli-refresh", expiresAt: Date.now() - 1000 } }),
  )
  let refreshCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    refreshCalls++
    await sleep(20)
    return Response.json({ access_token: "cli-fresh", refresh_token: "cli-refresh-2", expires_in: 3600 })
  }
  try {
    const results = await Promise.all([getCliAccessToken(), getCliAccessToken(), getCliAccessToken(), getCliAccessToken()])
    assert.equal(refreshCalls, 1, "exactly one CLI refresh for a concurrent burst")
    assert.deepEqual(results, ["cli-fresh", "cli-fresh", "cli-fresh", "cli-fresh"])
  } finally {
    globalThis.fetch = original
  }
})

test("getV1AuthAccessToken coalesces concurrent expired refreshes and writes back once", async () => {
  const authFile = path.join(sandbox, "xdg", "opencode", "auth.json")
  writeFileSync(
    authFile,
    JSON.stringify({ anthropic: { type: "oauth", access: "expired", refresh: "v1-refresh", expires: Date.now() - 1000 } }),
  )
  let refreshCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    refreshCalls++
    await sleep(20)
    return Response.json({ access_token: "v1-fresh", refresh_token: "v1-refresh-2", expires_in: 3600 })
  }
  try {
    const results = await Promise.all([getV1AuthAccessToken(), getV1AuthAccessToken(), getV1AuthAccessToken()])
    assert.equal(refreshCalls, 1, "exactly one V1 refresh for a concurrent burst")
    assert.deepEqual(results, ["v1-fresh", "v1-fresh", "v1-fresh"])
    const persisted = JSON.parse(readFileSync(authFile, "utf-8"))
    assert.equal(persisted.anthropic.access, "v1-fresh")
    assert.equal(persisted.anthropic.refresh, "v1-refresh-2")
  } finally {
    globalThis.fetch = original
  }
})
