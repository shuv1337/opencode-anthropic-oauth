import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { refreshTokens, USER_AGENT, BETA_FLAGS } from "./oauth.js"

// Claude Code 2.x canonical tool names (from pi-mono/cchistory)
const CC_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob",
  "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "KillShell", "NotebookEdit", "Skill", "Task",
  "TaskOutput", "TodoWrite", "WebFetch", "WebSearch",
]
const ccLookup = new Map(CC_TOOLS.map((t) => [t.toLowerCase(), t]))
const toCC = (name: string) => ccLookup.get(name.toLowerCase()) ?? name

export function transformBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") return body
  try {
    const parsed = JSON.parse(body) as {
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }
    // Rename tools to CC canonical casing
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? toCC(tool.name) : tool.name,
      }))
    }
    // Rename tool_use blocks in messages
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) return message
        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") return block
            return { ...block, name: toCC(block.name as string) }
          }),
        }
      })
    }
    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

function stripCCNames(text: string): string {
  // Reverse CC canonical names back to original in response stream
  for (const ccName of CC_TOOLS) {
    const re = new RegExp(`"name"\\s*:\\s*"${ccName}"`, "g")
    text = text.replace(re, `"name": "${ccName.toLowerCase()}"`)
  }
  return text
}

export function transformResponseStream(response: Response): Response {
  if (!response.body) return response

  // Don't transform error responses
  if (!response.ok) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const lfBoundary = buffer.indexOf("\n\n")
        const crlfBoundary = buffer.indexOf("\r\n\r\n")
        const boundary = lfBoundary === -1
          ? crlfBoundary
          : crlfBoundary === -1
            ? lfBoundary
            : Math.min(lfBoundary, crlfBoundary)
        if (boundary !== -1) {
          const separatorLength = boundary === crlfBoundary ? 4 : 2
          const completeEvent = buffer.slice(0, boundary + separatorLength)
          buffer = buffer.slice(boundary + separatorLength)
          controller.enqueue(encoder.encode(stripCCNames(completeEvent)))
          return
        }
        const { done, value } = await reader.read()
        if (done) {
          buffer += decoder.decode()
          if (buffer) {
            controller.enqueue(encoder.encode(stripCCNames(buffer)))
            buffer = ""
          }
          controller.close()
          return
        }
        buffer += decoder.decode(value, { stream: true })
      }
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

// --- Claude CLI credential reader ---
export interface CliCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export function readCliCredentials(
  credPath = join(homedir(), ".claude", ".credentials.json"),
): CliCredentials | null {
  try {
    if (!existsSync(credPath)) return null
    const raw = readFileSync(credPath, "utf-8")
    const parsed = JSON.parse(raw)
    const data = parsed.claudeAiOauth ?? parsed
    if (
      typeof data.accessToken === "string" &&
      typeof data.refreshToken === "string" &&
      typeof data.expiresAt === "number"
    ) {
      return data as CliCredentials
    }
    return null
  } catch {
    return null
  }
}

async function refreshCliToken(refreshToken: string): Promise<CliCredentials | null> {
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    })
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token) return null
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 36000) * 1000,
    }
  } catch {
    return null
  }
}

let cachedCliCreds: CliCredentials | null = null
// Single-flight guard: coalesce concurrent refreshes so a burst of
// simultaneous expired requests triggers exactly one token endpoint call
// (a fresh refresh per request otherwise races the refresh-token rotation).
let cliRefreshInFlight: Promise<CliCredentials | null> | null = null

export async function getCliAccessToken(): Promise<string | null> {
  if (cachedCliCreds && cachedCliCreds.expiresAt > Date.now() + 60_000) {
    return cachedCliCreds.accessToken
  }
  const fileCreds = readCliCredentials()
  if (!fileCreds) return null
  if (fileCreds.expiresAt > Date.now() + 60_000) {
    cachedCliCreds = fileCreds
    return fileCreds.accessToken
  }
  if (!cliRefreshInFlight) {
    cliRefreshInFlight = refreshCliToken(fileCreds.refreshToken).finally(() => {
      cliRefreshInFlight = null
    })
  }
  const fresh = await cliRefreshInFlight
  if (fresh) {
    cachedCliCreds = fresh
    return fresh.accessToken
  }
  return null
}

// --- opencode v1 auth.json reader ---
// v2 stores credentials in its own database, so a fresh v2 install has no
// anthropic connection even when v1 does. Reading (and refreshing) the v1
// entry keeps a Pro/Max login working across both versions.
export function v1AuthJsonPath(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(data, "opencode", "auth.json")
}

interface V1OAuthEntry {
  type: "oauth"
  access: string
  refresh: string
  expires: number
}

export function readV1OAuthEntry(file = v1AuthJsonPath()): V1OAuthEntry | null {
  try {
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, "utf-8"))
    const entry = parsed?.anthropic
    if (
      entry?.type === "oauth" &&
      typeof entry.access === "string" &&
      typeof entry.refresh === "string" &&
      typeof entry.expires === "number"
    ) {
      return entry as V1OAuthEntry
    }
    return null
  } catch {
    return null
  }
}

let cachedV1Entry: V1OAuthEntry | null = null
// Single-flight guard — see getCliAccessToken. Prevents concurrent expired
// requests from each rotating the v1 refresh token and racing the file write.
let v1RefreshInFlight: Promise<V1OAuthEntry | null> | null = null

export async function getV1AuthAccessToken(): Promise<string | null> {
  if (cachedV1Entry && cachedV1Entry.expires > Date.now() + 60_000) {
    return cachedV1Entry.access
  }
  const entry = readV1OAuthEntry()
  if (!entry) return null
  if (entry.expires > Date.now() + 60_000) {
    cachedV1Entry = entry
    return entry.access
  }
  if (!v1RefreshInFlight) {
    v1RefreshInFlight = (async (): Promise<V1OAuthEntry | null> => {
      try {
        const fresh = await refreshTokens(entry.refresh)
        const next: V1OAuthEntry = {
          type: "oauth",
          access: fresh.access,
          refresh: fresh.refresh,
          expires: fresh.expires,
        }
        cachedV1Entry = next
        // Write the rotated refresh token back so v1 sessions keep working.
        try {
          const file = v1AuthJsonPath()
          const parsed = JSON.parse(readFileSync(file, "utf-8"))
          parsed.anthropic = next
          writeFileSync(file, JSON.stringify(parsed, null, 2))
        } catch {
          // Non-fatal: token still usable this session.
        }
        return next
      } catch {
        return null
      }
    })().finally(() => {
      v1RefreshInFlight = null
    })
  }
  const next = await v1RefreshInFlight
  return next ? next.access : null
}

export function hasV1OAuthEntry(): boolean {
  return readV1OAuthEntry() !== null
}

export function hasCliCredentials(): boolean {
  return readCliCredentials() !== null
}

// --- Constants ---
export const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."

/**
 * Rewrite a host `<env>...</env>` block into the exact shape genuine Claude
 * Code sends.
 *
 * Claude Pro/Max subscription billing inspects the system prompt and, when an
 * `<env>` block is present, fuzzy-matches it against the real Claude Code
 * format. A block that diverges — e.g. OpenCode's extra `Workspace root
 * folder:` line, two-space indentation, or the date placed outside the tag —
 * is treated as a counterfeit and the request is billed as pay-as-you-go
 * "extra usage" instead of drawing from the subscription. Header/tool/message
 * shaping alone does not satisfy the check; the block itself must look
 * authentic. Normalizing it preserves the agent's environment awareness while
 * keeping the request on-subscription. Verified against build
 * `0.0.0-next-15329` on 2026-07-11.
 */
export function normalizeClaudeCodeEnv(text: string): string {
  return text.replace(
    /(?:[^\n]*(?:useful )?information about the environment you are running in:\n)?<env>\n([\s\S]*?)\n<\/env>((?:\n+Today's date:[^\n]*)?)/,
    (_match, inner: string, trailingDate: string) => {
      const lines = String(inner)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        // Drop harness-specific keys that never appear in genuine Claude Code.
        .filter((line) => !/^Workspace root folder:/i.test(line))
      const dateMatch = trailingDate.match(/Today's date:\s*(.+)\s*$/)
      if (dateMatch && !lines.some((line) => /^Today's date:/i.test(line))) {
        lines.push(`Today's date: ${dateMatch[1].trim()}`)
      }
      return `Here is useful information about the environment you are running in:\n<env>\n${lines.join("\n")}\n</env>`
    },
  )
}

const MAX_RETRY_DELAY_S = 20

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? Number.parseInt(retryAfter, 10) : Number.NaN
      const delay = Number.isNaN(parsed)
        ? (i + 1) * 2000
        : Math.min(parsed, MAX_RETRY_DELAY_S) * 1000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

/**
 * Performs a request against the Anthropic API authorized with an OAuth
 * access token, applying every transformation the Claude Code billing
 * path requires: Bearer auth, beta flags, CC tool-name casing, the Claude
 * Code system identity, and reverse tool-name mapping on the response.
 */
export async function oauthRequest(
  access: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  // Constructing a Request applies native Request + overriding init merge
  // semantics and preserves Request-only bodies, methods, and abort signals.
  const source = new Request(input, init)
  const headers = new Headers(source.headers)

  // Merge beta flags
  const incoming = (headers.get("anthropic-beta") || "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean)
  const required = BETA_FLAGS.split(",").map((b) => b.trim())
  const merged = [...new Set([...required, ...incoming])].join(",")

  headers.set("authorization", `Bearer ${access}`)
  headers.set("anthropic-beta", merged)
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("user-agent", USER_AGENT)
  headers.set("x-app", "cli")
  headers.delete("x-api-key")
  // No x-anthropic-billing-header (pi-mono doesn't send it)

  const url = source.url
  // No ?beta=true (pi-mono doesn't add it)

  // opencode v2's native LLM route sends JSON bodies as bytes; decode them
  // so the system-identity and tool-name transforms below still apply.
  let body: BodyInit | null | undefined
  const hasBody = source.method !== "GET" && source.method !== "HEAD" && source.body !== null
  const isJson = (headers.get("content-type") ?? "").toLowerCase().includes("json")
  if (hasBody && isJson) body = new TextDecoder().decode(await source.arrayBuffer())
  else if (hasBody) body = source.body

  // Transform body for the subscription billing path:
  //   1. Force the first system entry to the Claude Code identity.
  //   2. Normalize any `<env>` block in the remaining entries so it matches
  //      genuine Claude Code — a counterfeit block bills as "extra usage"
  //      rather than drawing from the subscription (see normalizeClaudeCodeEnv).
  // All other host/plugin system content is preserved so the agent keeps its
  // instructions.
  if (typeof body === "string" && url.includes("/v1/messages")) {
    try {
      const parsed = JSON.parse(body)
      const identity = { type: "text", text: SYSTEM_IDENTITY }
      if (Array.isArray(parsed.system) && parsed.system.length > 0) {
        parsed.system = parsed.system.map((entry: unknown, index: number) => {
          if (index === 0) return identity
          if (entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string") {
            const block = entry as { type?: string; text: string }
            return { ...block, text: normalizeClaudeCodeEnv(block.text) }
          }
          return entry
        })
      } else if (typeof parsed.system === "string" && parsed.system.length > 0) {
        // A single string system prompt: prepend the identity and normalize.
        parsed.system = [identity, { type: "text", text: normalizeClaudeCodeEnv(parsed.system) }]
      } else {
        parsed.system = [identity]
      }
      // The V2 host merges provider.body into the request payload, so the
      // catalog sentinel (or any configured key) arrives as an `apiKey`
      // field the Anthropic API rejects as an extra input.
      delete parsed.apiKey
      body = JSON.stringify(parsed)
    } catch {
      // leave body as-is
    }
  }

  // Rename tools to CC canonical casing (pi-mono approach)
  body = transformBody(body) ?? body

  const requestInit: RequestInit & { duplex?: "half" } = {
    method: source.method,
    headers,
    body,
    signal: source.signal,
    cache: source.cache,
    credentials: source.credentials,
    integrity: source.integrity,
    keepalive: source.keepalive,
    mode: source.mode,
    redirect: source.redirect,
    referrer: source.referrer,
    referrerPolicy: source.referrerPolicy,
  }
  if (body instanceof ReadableStream) requestInit.duplex = "half"
  const response = await fetchWithRetry(url, requestInit, body instanceof ReadableStream ? 1 : 3, fetchImpl)

  return transformResponseStream(response)
}
