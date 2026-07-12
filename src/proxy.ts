import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { oauthRequest } from "./shared.js"

const ANTHROPIC_ORIGIN = "https://api.anthropic.com"

// Hop-by-hop headers and fetch-forbidden request headers that must not be
// forwarded verbatim to the upstream Anthropic request.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "expect",
  "te",
])

// Response headers that describe the local hop and must be recomputed by the
// Node server rather than copied from the upstream response.
const STRIP_RESPONSE_HEADERS = new Set(["content-length", "content-encoding", "transfer-encoding", "connection"])

export interface OAuthProxy {
  /** Base URL to point the provider's `settings.baseURL` at, e.g. `http://127.0.0.1:54123`. */
  readonly url: string
  close(): Promise<void>
}

const readBody = (req: IncomingMessage): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })

const errorPayload = (type: string, message: string) =>
  JSON.stringify({ type: "error", error: { type, message } })

/**
 * Start a loopback reverse proxy that turns OpenCode's native Anthropic route
 * into a Claude Pro/Max subscription request.
 *
 * Recent OpenCode builds dispatch native Anthropic requests through an Effect
 * `HttpClient` (a memoized `globalThis.fetch` reference resolved inside the
 * runtime), not through `globalThis.fetch` at call time, and always send the
 * credential as `x-api-key`. A plugin can no longer intercept that dispatch by
 * patching `globalThis.fetch`. Redirecting the provider's `baseURL` to this
 * loopback proxy is the stable seam: OpenCode connects here over plain HTTP,
 * and the proxy applies the full OAuth transformation (`oauthRequest`) before
 * forwarding to Anthropic over HTTPS.
 *
 * The proxy resolves the OAuth token itself (so token refresh is always
 * honoured regardless of what OpenCode sent), and forwards to Anthropic with a
 * captured `fetchImpl` so it never re-enters any installed global fetch patch.
 */
export async function startOAuthProxy(input: {
  getAccessToken: () => Promise<string | null>
  /** Captured original fetch, used for the upstream call to avoid re-entering a global patch. */
  fetchImpl?: typeof fetch
}): Promise<OAuthProxy> {
  const fetchImpl = input.fetchImpl ?? fetch

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const access = await input.getAccessToken()
    if (!access) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(errorPayload("authentication_error", "opencode-anthropic-oauth: no OAuth credential is available"))
      return
    }

    const url = ANTHROPIC_ORIGIN + (req.url ?? "/")
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue
      headers.set(name, Array.isArray(value) ? value.join(", ") : value)
    }

    const method = (req.method ?? "POST").toUpperCase()
    const raw = method === "GET" || method === "HEAD" ? undefined : await readBody(req)
    // A byte body is a valid BodyInit at runtime; the DOM lib typing omits it.
    const body = raw && raw.byteLength > 0 ? (raw as unknown as BodyInit) : undefined

    const upstream = await oauthRequest(access, url, { method, headers, body }, fetchImpl)

    const outHeaders: Record<string, string> = {}
    upstream.headers.forEach((value, key) => {
      if (STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) return
      outHeaders[key] = value
    })
    res.writeHead(upstream.status, outHeaders)

    if (!upstream.body) {
      res.end()
      return
    }
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
    res.end()
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
      res.end(errorPayload("proxy_error", `opencode-anthropic-oauth proxy failed: ${message}`))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject)
      resolve()
    })
  })

  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  if (!port) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error("opencode-anthropic-oauth: proxy failed to bind a loopback port")
  }

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}
