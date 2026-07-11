import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import {
  oauthRequest,
  readCliCredentials,
  readV1OAuthEntry,
  transformBody,
  transformResponseStream,
} from "../dist/shared.js"

test("credential readers reject malformed fixtures and accept isolated valid fixtures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "anthropic-oauth-test-"))
  const cli = path.join(root, "cli.json")
  const v1 = path.join(root, "auth.json")
  writeFileSync(cli, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 123 } }))
  writeFileSync(v1, JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 123 } }))
  assert.equal(readCliCredentials(cli).accessToken, "a")
  assert.equal(readV1OAuthEntry(v1).access, "a")
  writeFileSync(cli, "{}")
  assert.equal(readCliCredentials(cli), null)
})

test("request body maps tool names to Claude Code casing", () => {
  const transformed = JSON.parse(transformBody(JSON.stringify({
    tools: [{ name: "read" }],
    messages: [{ content: [{ type: "tool_use", name: "webfetch" }] }],
  })))
  assert.equal(transformed.tools[0].name, "Read")
  assert.equal(transformed.messages[0].content[0].name, "WebFetch")
})

test("OAuth request preserves Request-only method, body, signal, and removes API key", async () => {
  const controller = new AbortController()
  const input = new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sentinel" },
    body: JSON.stringify({ system: [{ type: "text", text: "original" }], tools: [{ name: "read" }] }),
    signal: controller.signal,
  })
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return new Response("data: {\"name\":\"Read\"}\r\n\r\n", {
      headers: { "content-type": "text/event-stream" },
    })
  }
  const response = await oauthRequest("oauth-access", input, undefined, fetchImpl)
  assert.equal(captured.init.method, "POST")
  assert.equal(captured.init.headers.get("x-api-key"), null)
  assert.equal(captured.init.headers.get("authorization"), "Bearer oauth-access")
  assert.equal(captured.init.signal.aborted, false)
  controller.abort()
  assert.equal(captured.init.signal.aborted, true)
  const body = JSON.parse(captured.init.body)
  assert.match(body.system[0].text, /Claude Code/)
  assert.equal(body.tools[0].name, "Read")
  assert.match(await response.text(), /\"name\": \"read\"/)
})

test("response stream handles CRLF boundaries", async () => {
  const response = transformResponseStream(new Response("data: {\"name\":\"Bash\"}\r\n\r\n"))
  assert.match(await response.text(), /\"name\": \"bash\"/)
})
