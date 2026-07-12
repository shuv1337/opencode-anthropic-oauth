import assert from "node:assert/strict"
import test from "node:test"
import { startOAuthProxy } from "../dist/proxy.js"

// The proxy is the interception seam for recent OpenCode builds: the native
// Anthropic route reaches it over plain HTTP carrying the OAuth token as
// `x-api-key`, and the proxy must forward to Anthropic with `Authorization:
// Bearer`, the OAuth token resolved from the plugin (not the header), the
// x-api-key dropped, and the Claude Code body/header shaping applied.

const OC_ENV = [
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /home/shuv",
  "  Workspace root folder: /",
  "  Platform: linux",
  "</env>",
  "",
  "Today's date: Sat Jul 11 2026",
].join("\n")

function captureFetch(responseFactory = () => new Response("data: {}\r\n\r\n", { headers: { "content-type": "text/event-stream" } })) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url instanceof Request ? url.url : url), init, request: url instanceof Request ? url : undefined })
    return responseFactory()
  }
  return { impl, calls }
}

async function withProxy(opts, body) {
  const proxy = await startOAuthProxy(opts)
  try {
    return await body(proxy)
  } finally {
    await proxy.close()
  }
}

test("proxy rewrites x-api-key OAuth requests into Bearer + Claude Code shaping", async () => {
  const { impl, calls } = captureFetch()
  await withProxy({ getAccessToken: async () => "resolved-oauth-token", fetchImpl: impl }, async (proxy) => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-ant-oat01-stale-from-opencode" },
      body: JSON.stringify({ system: [{ type: "text", text: OC_ENV }], tools: [{ name: "read" }] }),
    })
    assert.equal(res.status, 200)
  })

  assert.equal(calls.length, 1)
  // Forwarded to the real Anthropic host, preserving the path.
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/messages")
  const sent = calls[0].request ?? new Request(calls[0].url, calls[0].init)
  const headers = new Headers(sent.headers)
  // The plugin-resolved token is used as a Bearer, not the (possibly stale) header.
  assert.equal(headers.get("authorization"), "Bearer resolved-oauth-token")
  assert.equal(headers.get("x-api-key"), null)
  assert.match(headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/)
  assert.equal(headers.get("x-app"), "cli")
  // Body carries the Claude Code identity and a normalized env block.
  const forwardedBody = JSON.parse(await sent.text())
  assert.match(forwardedBody.system[0].text, /Claude Code/)
  assert.doesNotMatch(JSON.stringify(forwardedBody.system), /Workspace root folder:/)
  assert.equal(forwardedBody.tools[0].name, "Read")
})

test("proxy returns 401 when no OAuth credential is available", async () => {
  const { impl, calls } = captureFetch()
  await withProxy({ getAccessToken: async () => null, fetchImpl: impl }, async (proxy) => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: [] }),
    })
    assert.equal(res.status, 401)
    const payload = await res.json()
    assert.equal(payload.error.type, "authentication_error")
  })
  assert.equal(calls.length, 0)
})

test("proxy streams the upstream response body back to the caller", async () => {
  const sse = 'event: message_start\r\ndata: {"type":"message_start"}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'
  const { impl } = captureFetch(() => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }))
  await withProxy({ getAccessToken: async () => "tok", fetchImpl: impl }, async (proxy) => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: [] }),
    })
    const text = await res.text()
    assert.match(text, /message_start/)
    assert.match(text, /message_stop/)
  })
})

test("proxy surfaces a 502 with a redacted message when the upstream call throws", async () => {
  const impl = async () => {
    throw new Error("boom")
  }
  await withProxy({ getAccessToken: async () => "tok", fetchImpl: impl }, async (proxy) => {
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: [] }),
    })
    assert.equal(res.status, 502)
    const payload = await res.json()
    assert.equal(payload.error.type, "proxy_error")
  })
})
