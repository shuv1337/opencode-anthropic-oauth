import assert from "node:assert/strict"
import test from "node:test"
import { normalizeClaudeCodeEnv, oauthRequest } from "../dist/shared.js"

// Regression coverage for the Claude Pro/Max subscription billing path.
//
// Anthropic bills OAuth requests as pay-as-you-go "extra usage" unless the
// system prompt looks like genuine Claude Code, including its `<env>` block.
// OpenCode injects a counterfeit block (extra `Workspace root folder:` line,
// two-space indentation, `some useful`, date outside the tag). The plugin must
// rewrite it into the authentic Claude Code shape. Empirically bisected against
// build 0.0.0-next-15329 on 2026-07-11: the divergent `<env>` block was the
// sole trigger; headers, tools, and messages were accepted.

const OC_ENV = [
  "Here is some useful information about the environment you are running in:",
  "<env>",
  "  Working directory: /home/shuv",
  "  Workspace root folder: /",
  "  Is directory a git repo: no",
  "  Platform: linux",
  "</env>",
  "",
  "Today's date: Sat Jul 11 2026",
].join("\n")

test("normalizeClaudeCodeEnv rewrites OpenCode's env block to the Claude Code shape", () => {
  const out = normalizeClaudeCodeEnv(OC_ENV)
  assert.match(out, /^Here is useful information about the environment you are running in:\n<env>\n/)
  // Harness-specific line is dropped.
  assert.doesNotMatch(out, /Workspace root folder:/)
  // No leading indentation inside the block.
  assert.doesNotMatch(out, /\n {2}\w/)
  // The date moves inside the <env> block.
  assert.match(out, /Working directory: \/home\/shuv\nIs directory a git repo: no\nPlatform: linux\nToday's date: Sat Jul 11 2026\n<\/env>/)
  // Genuine environment facts are preserved.
  assert.match(out, /Working directory: \/home\/shuv/)
  assert.match(out, /Platform: linux/)
})

test("normalizeClaudeCodeEnv preserves surrounding prompt text and is a no-op without an env block", () => {
  const withTail = `${OC_ENV}\n\nSkills provide specialized instructions.\n<available_skills></available_skills>`
  const out = normalizeClaudeCodeEnv(withTail)
  assert.match(out, /Skills provide specialized instructions\.\n<available_skills><\/available_skills>$/)

  const noEnv = "You are a helpful assistant. The user's name is Kyle."
  assert.equal(normalizeClaudeCodeEnv(noEnv), noEnv)
})

test("oauthRequest normalizes the env block in a non-identity system entry", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response("data: {}\r\n\r\n", { headers: { "content-type": "text/event-stream" } })
  }
  await oauthRequest(
    "oauth-access",
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system: [
          { type: "text", text: "Some other identity" },
          { type: "text", text: OC_ENV },
        ],
      }),
    },
    fetchImpl,
  )
  const sent = JSON.parse(calls[0].init.body)
  // First entry is forced to the Claude Code identity.
  assert.match(sent.system[0].text, /^You are Claude Code, Anthropic's official CLI for Claude\.$/)
  // Second entry's env block is normalized, not passed through verbatim.
  assert.match(sent.system[1].text, /Here is useful information about the environment/)
  assert.doesNotMatch(sent.system[1].text, /Workspace root folder:/)
  assert.doesNotMatch(sent.system[1].text, /some useful information/)
})

test("oauthRequest promotes a string system prompt and normalizes its env block", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return new Response("data: {}\r\n\r\n", { headers: { "content-type": "text/event-stream" } })
  }
  await oauthRequest(
    "oauth-access",
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ system: OC_ENV }),
    },
    fetchImpl,
  )
  const sent = JSON.parse(calls[0].init.body)
  assert.ok(Array.isArray(sent.system))
  assert.match(sent.system[0].text, /^You are Claude Code/)
  assert.match(sent.system[1].text, /Here is useful information about the environment/)
  assert.doesNotMatch(sent.system[1].text, /Workspace root folder:/)
})
