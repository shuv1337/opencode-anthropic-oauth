import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import plugin, { SENTINEL_KEY } from "../dist/v2.js"
import { makeMockCtx, pushEvent, runCatalogTransform, waitFor } from "./mock-ctx.mjs"

const MESSAGES_URL = "https://api.anthropic.com/v1/messages"
const future = () => Date.now() + 3600_000
const connectionUpdated = { type: "integration.connection.updated", data: { integrationID: "anthropic" } }

// --- item 3 (V2 side): authorize + refresh Effects via the registered method -

test("registered authorize method builds a PKCE URL and exchanges a code", async () => {
  const { ctx, state } = makeMockCtx({ credential: { type: "oauth", access: "a", refresh: "r", expires: future() } })
  const cleanup = await plugin.setup(ctx)
  try {
    assert.ok(state.methodRegistration, "method registration captured")
    const authorization = await Effect.runPromise(state.methodRegistration.authorize({}))
    assert.equal(authorization.mode, "code")
    assert.ok(new URL(authorization.url).searchParams.get("code_challenge"))

    const original = globalThis.fetch
    globalThis.fetch = async () =>
      Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })
    try {
      const result = await Effect.runPromise(authorization.callback("auth-code#frag"))
      assert.equal(result.type, "oauth")
      assert.equal(result.methodID, "claude-pro-max")
      assert.equal(result.access, "fresh-access")
      assert.equal(result.refresh, "fresh-refresh")
    } finally {
      globalThis.fetch = original
    }
  } finally {
    await cleanup()
  }
})

test("authorize callback fails with a generic error that omits response bodies", async () => {
  const { ctx, state } = makeMockCtx({ credential: { type: "oauth", access: "a", refresh: "r", expires: future() } })
  const cleanup = await plugin.setup(ctx)
  try {
    const authorization = await Effect.runPromise(state.methodRegistration.authorize({}))
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response("server-side-secret-detail", { status: 400 })
    try {
      await assert.rejects(Effect.runPromise(authorization.callback("bad")), (error) => {
        assert.doesNotMatch(error.message, /server-side-secret-detail/)
        return true
      })
    } finally {
      globalThis.fetch = original
    }
  } finally {
    await cleanup()
  }
})

test("registered refresh method rotates tokens while preserving credential metadata", async () => {
  const { ctx, state } = makeMockCtx({ credential: { type: "oauth", access: "a", refresh: "r", expires: future() } })
  const cleanup = await plugin.setup(ctx)
  try {
    const original = globalThis.fetch
    globalThis.fetch = async () =>
      Response.json({ access_token: "rot-access", refresh_token: "rot-refresh", expires_in: 3600 })
    try {
      const credential = {
        type: "oauth",
        methodID: "claude-pro-max",
        access: "old-access",
        refresh: "old-refresh",
        expires: 1,
        provider: "keep-me",
      }
      const result = await Effect.runPromise(state.methodRegistration.refresh(credential))
      assert.equal(result.access, "rot-access")
      assert.equal(result.refresh, "rot-refresh")
      assert.equal(result.methodID, "claude-pro-max")
      assert.equal(result.provider, "keep-me")
    } finally {
      globalThis.fetch = original
    }
  } finally {
    await cleanup()
  }
})

// --- item 7: auth-mode transitions --------------------------------------------

test("auth-mode transitions flip catalog cost and fetch interception", async () => {
  const capturedFetch = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    capturedFetch.push({ input, init })
    return new Response("passthrough")
  }

  const { ctx, state } = makeMockCtx({ credential: undefined, options: {} })
  const cleanup = await plugin.setup(ctx)
  try {
    // helper: exercise the installed fetch patch and report the Bearer header
    const bearerFor = async () => {
      capturedFetch.length = 0
      await fetch(MESSAGES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
        body: "{}",
      })
      const init = capturedFetch.at(-1)?.init
      return new Headers(init?.headers).get("authorization")
    }
    const transitionTo = async (credential) => {
      const before = state.catalogReloads
      state.credential = credential
      pushEvent(state, connectionUpdated)
      await waitFor(() => state.catalogReloads > before)
    }

    // Start: no auth -> inactive, cost untouched, requests pass through
    assert.deepEqual(runCatalogTransform(state).modelCosts, {})
    assert.equal(await bearerFor(), null)

    // no auth -> OAuth
    await transitionTo({ type: "oauth", access: "oauth-token", refresh: "r", expires: future() })
    const oauthCatalog = runCatalogTransform(state)
    assert.equal(oauthCatalog.providerBody.apiKey, SENTINEL_KEY)
    assert.deepEqual(oauthCatalog.modelCosts["claude-sonnet"], [])
    assert.equal(await bearerFor(), "Bearer oauth-token")

    // OAuth -> API key
    await transitionTo({ type: "key" })
    assert.deepEqual(runCatalogTransform(state).modelCosts, {})
    assert.equal(await bearerFor(), null)

    // API key -> OAuth
    await transitionTo({ type: "oauth", access: "oauth-token-2", refresh: "r", expires: future() })
    assert.deepEqual(runCatalogTransform(state).modelCosts["claude-sonnet"], [])
    assert.equal(await bearerFor(), "Bearer oauth-token-2")

    // logout (OAuth -> no auth)
    await transitionTo(undefined)
    assert.deepEqual(runCatalogTransform(state).modelCosts, {})
    assert.equal(await bearerFor(), null)
  } finally {
    await cleanup()
    globalThis.fetch = original
  }
})

// --- item 6: token expiry between catalog resolution and request dispatch -----

test("a token refreshed by the host between resolution and dispatch is picked up", async () => {
  // Simulates the host rotating the stored credential (e.g. its own refresh)
  // after catalog resolution: the plugin re-resolves on every dispatch, so the
  // fresh access token is used without any stale caching.
  const capturedFetch = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    capturedFetch.push({ input, init })
    return new Response("ok")
  }
  const { ctx, state } = makeMockCtx({
    credential: { type: "oauth", access: "valid-at-catalog", refresh: "r", expires: future() },
  })
  const cleanup = await plugin.setup(ctx)
  try {
    const dispatch = async () => {
      capturedFetch.length = 0
      await fetch(MESSAGES_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
        body: "{}",
      })
      return new Headers(capturedFetch.at(-1)?.init?.headers).get("authorization")
    }
    assert.equal(await dispatch(), "Bearer valid-at-catalog")
    // Host refreshes the stored credential; next dispatch must use the new token.
    state.credential = { type: "oauth", access: "refreshed-at-dispatch", refresh: "r2", expires: future() }
    assert.equal(await dispatch(), "Bearer refreshed-at-dispatch")
  } finally {
    await cleanup()
    globalThis.fetch = original
  }
})
