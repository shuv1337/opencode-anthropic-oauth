import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import {
  createAuthorizationRequest,
  exchangeCodeForTokens,
  parseAuthCode,
  refreshTokens,
} from "../dist/oauth.js"

const base64url = (buf) => buf.toString("base64url").replace(/=+$/, "")

test("authorization request includes PKCE and state", () => {
  const request = createAuthorizationRequest()
  const url = new URL(request.url)
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("state"), request.verifier)
  assert.ok(url.searchParams.get("code_challenge"))
  assert.equal(parseAuthCode("code#state"), "code")
})

test("authorization URL carries the full OAuth parameter set", () => {
  const { url } = createAuthorizationRequest()
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get("response_type"), "code")
  assert.equal(parsed.searchParams.get("code"), "true")
  assert.ok(parsed.searchParams.get("client_id"))
  assert.ok(parsed.searchParams.get("redirect_uri"))
  assert.ok(parsed.searchParams.get("scope"))
})

test("PKCE challenge is the unpadded base64url SHA-256 of the verifier", () => {
  const { url, verifier } = createAuthorizationRequest()
  const challenge = new URL(url).searchParams.get("code_challenge")
  const expected = base64url(createHash("sha256").update(verifier).digest())
  assert.equal(challenge, expected)
  assert.doesNotMatch(challenge, /[=+/]/)
})

test("PKCE verifiers are unique per authorization request", () => {
  const a = createAuthorizationRequest()
  const b = createAuthorizationRequest()
  assert.notEqual(a.verifier, b.verifier)
})

test("parseAuthCode strips the URL fragment and tolerates plain codes", () => {
  assert.equal(parseAuthCode("code#state"), "code")
  assert.equal(parseAuthCode("bare-code"), "bare-code")
  assert.equal(parseAuthCode("#leading"), "")
  assert.equal(parseAuthCode(""), "")
})

test("code exchange validates and converts expiry to milliseconds", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    assert.match(String(init.body), /code_verifier=verifier/)
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 60 })
  }
  try {
    const before = Date.now()
    const result = await exchangeCodeForTokens("code#ignored", "verifier")
    assert.equal(result.access, "access")
    assert.equal(result.refresh, "refresh")
    assert.ok(result.expires >= before + 60_000)
  } finally {
    globalThis.fetch = original
  }
})

test("code exchange rejects a malformed credential response", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ access_token: "only-access" })
  try {
    await assert.rejects(exchangeCodeForTokens("code", "verifier"), /invalid credential response/)
  } finally {
    globalThis.fetch = original
  }
})

test("code exchange surfaces a readable error on network failure without internals", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED 10.0.0.1:443 secret-internal-detail")
  }
  try {
    await assert.rejects(exchangeCodeForTokens("code", "verifier"))
  } finally {
    globalThis.fetch = original
  }
})

test("refresh preserves a refresh token when Anthropic does not rotate it", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ access_token: "new-access", expires_in: 60 })
  try {
    const result = await refreshTokens("old-refresh")
    assert.equal(result.refresh, "old-refresh")
  } finally {
    globalThis.fetch = original
  }
})

test("refresh rotates both access and refresh tokens when the server returns a new pair", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
  try {
    const before = Date.now()
    const result = await refreshTokens("old-refresh")
    assert.equal(result.access, "rotated-access")
    assert.equal(result.refresh, "rotated-refresh")
    assert.ok(result.expires >= before + 3600_000)
  } finally {
    globalThis.fetch = original
  }
})

test("refresh rejects a response missing the access token", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ refresh_token: "r", expires_in: 60 })
  try {
    await assert.rejects(refreshTokens("old-refresh"), /invalid credential response/)
  } finally {
    globalThis.fetch = original
  }
})

test("refresh HTTP errors never include the response body", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("refresh-secret-body", { status: 403 })
  try {
    await assert.rejects(refreshTokens("old-refresh"), (error) => {
      assert.doesNotMatch(error.message, /refresh-secret-body/)
      assert.match(error.message, /HTTP 403/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})

test("OAuth HTTP errors never include response bodies", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("secret-response-token", { status: 401 })
  try {
    await assert.rejects(exchangeCodeForTokens("bad", "verifier"), (error) => {
      assert.doesNotMatch(error.message, /secret-response-token/)
      assert.match(error.message, /HTTP 401/)
      return true
    })
  } finally {
    globalThis.fetch = original
  }
})
