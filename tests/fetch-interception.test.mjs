import assert from "node:assert/strict"
import test from "node:test"
import { oauthRequest } from "../dist/shared.js"
import { installFetchPatch, SENTINEL_KEY } from "../dist/v2.js"

const MESSAGES_URL = "https://api.anthropic.com/v1/messages"

function capturer(responseFactory = () => new Response("data: {}\r\n\r\n", { headers: { "content-type": "text/event-stream" } })) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    return responseFactory(url, init)
  }
  return { impl, calls }
}

// --- oauthRequest variant matrix ---------------------------------------------

test("variant: URL string + init with JSON body is decoded and transformed", async () => {
  const { impl, calls } = capturer()
  await oauthRequest("tok", MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ system: [{ type: "text", text: "original" }], tools: [{ name: "read" }] }),
  }, impl)
  const body = JSON.parse(calls[0].init.body)
  assert.match(body.system[0].text, /Claude Code/)
  assert.equal(body.tools[0].name, "Read")
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer tok")
})

test("variant: host-merged apiKey field is stripped from the JSON body", async () => {
  const { impl, calls } = capturer()
  await oauthRequest("tok", MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: SENTINEL_KEY, system: [{ type: "text", text: "original" }] }),
  }, impl)
  const body = JSON.parse(calls[0].init.body)
  assert.equal("apiKey" in body, false)
  assert.match(body.system[0].text, /Claude Code/)
})

test("variant: Request without init preserves the Request-only body (never dropped)", async () => {
  const { impl, calls } = capturer()
  const request = new Request(MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker: "request-only" }),
  })
  await oauthRequest("tok", request, undefined, impl)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.marker, "request-only")
})

test("variant: non-JSON body carried only by a Request is forwarded, not dropped", async () => {
  const { impl, calls } = capturer()
  const request = new Request("https://api.anthropic.com/v1/complete", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "raw-payload-not-json",
  })
  await oauthRequest("tok", request, undefined, impl)
  const forwarded = await new Response(calls[0].init.body).text()
  assert.equal(forwarded, "raw-payload-not-json")
})

test("variant: init overrides a Request header", async () => {
  const { impl, calls } = capturer()
  const request = new Request(MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-custom": "from-request" },
    body: "{}",
  })
  await oauthRequest("tok", request, { headers: { "x-custom": "from-init" } }, impl)
  assert.equal(calls[0].init.headers.get("x-custom"), "from-init")
})

test("variant: JSON byte body (Uint8Array) is decoded and transformed", async () => {
  const { impl, calls } = capturer()
  const bytes = new TextEncoder().encode(JSON.stringify({ system: [{ type: "text", text: "x" }], tools: [{ name: "bash" }] }))
  await oauthRequest("tok", MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
  }, impl)
  assert.equal(typeof calls[0].init.body, "string")
  const body = JSON.parse(calls[0].init.body)
  assert.match(body.system[0].text, /Claude Code/)
  assert.equal(body.tools[0].name, "Bash")
})

test("variant: streaming body forwards as a stream with duplex half", async () => {
  const { impl, calls } = capturer()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"))
      controller.close()
    },
  })
  await oauthRequest("tok", "https://api.anthropic.com/v1/complete", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: stream,
    duplex: "half",
  }, impl)
  assert.equal(calls[0].init.duplex, "half")
  assert.ok(calls[0].init.body instanceof ReadableStream)
})

test("variant: non-JSON request body is passed through untouched", async () => {
  const { impl, calls } = capturer()
  await oauthRequest("tok", "https://api.anthropic.com/v1/complete", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "plain-text-body",
  }, impl)
  const forwarded = await new Response(calls[0].init.body).text()
  assert.equal(forwarded, "plain-text-body")
})

test("variant: abort signal from init is propagated", async () => {
  const { impl, calls } = capturer()
  const controller = new AbortController()
  await oauthRequest("tok", MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: controller.signal,
  }, impl)
  assert.equal(calls[0].init.signal.aborted, false)
  controller.abort()
  assert.equal(calls[0].init.signal.aborted, true)
})

test("variant: abort signal carried by a Request is propagated", async () => {
  const { impl, calls } = capturer()
  const controller = new AbortController()
  const request = new Request(MESSAGES_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: controller.signal,
  })
  await oauthRequest("tok", request, undefined, impl)
  controller.abort()
  assert.equal(calls[0].init.signal.aborted, true)
})

// --- fetch patch wrapper (installFetchPatch) ---------------------------------

async function withPatch({ active = async () => true, token = async () => "oauth-access" }, run) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return new Response("passthrough")
  }
  const base = globalThis.fetch
  const cleanup = installFetchPatch(active, token)
  try {
    await run(calls)
  } finally {
    cleanup()
    assert.equal(globalThis.fetch, base)
    globalThis.fetch = original
  }
}

test("wrapper: non-Anthropic hosts pass through untouched", async () => {
  await withPatch({}, async (calls) => {
    await fetch("https://example.com/anything", { headers: { "x-api-key": SENTINEL_KEY } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].input, "https://example.com/anything")
    // No Authorization injected on passthrough
    const headers = new Headers(calls[0].init?.headers)
    assert.equal(headers.get("authorization"), null)
  })
})

test("wrapper: real API-key Anthropic requests pass through unchanged", async () => {
  await withPatch({}, async (calls) => {
    await fetch(MESSAGES_URL, { headers: { "x-api-key": "sk-ant-api03-real-key" } })
    assert.equal(calls.length, 1)
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null)
  })
})

test("wrapper: sentinel-keyed Anthropic requests are intercepted with a Bearer token", async () => {
  await withPatch({}, async (calls) => {
    await fetch(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
      body: "{}",
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer oauth-access")
    assert.equal(calls[0].init.headers.get("x-api-key"), null)
  })
})

test("wrapper: sk-ant-oat OAuth keys are honoured even when no stored token exists", async () => {
  await withPatch({ token: async () => null }, async (calls) => {
    await fetch(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-oat01-passthrough" },
      body: "{}",
    })
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer sk-ant-oat01-passthrough")
  })
})

test("wrapper: init headers override Request headers when deciding interception", async () => {
  await withPatch({}, async (calls) => {
    // Request carries a real key; init overrides with the sentinel -> intercept.
    const request = new Request(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-api03-real" },
      body: "{}",
    })
    await fetch(request, { headers: { "x-api-key": SENTINEL_KEY } })
    assert.equal(calls[0].init.headers.get("authorization"), "Bearer oauth-access")
  })
})

test("wrapper: passes through when OAuth mode is inactive", async () => {
  await withPatch({ active: async () => false }, async (calls) => {
    await fetch(MESSAGES_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": SENTINEL_KEY },
      body: "{}",
    })
    assert.equal(new Headers(calls[0].init?.headers).get("authorization"), null)
  })
})
