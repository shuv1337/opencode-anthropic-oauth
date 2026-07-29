# opencode-anthropic-oauth

OpenCode plugin for Anthropic Claude Pro/Max OAuth login — no Claude Code needed.

## What it does

Lets you authenticate with your Claude Pro/Max subscription directly in OpenCode via browser OAuth. No need to install Claude Code or manage credentials files.

## OpenCode V1 installation

```bash
npm install -g opencode-anthropic-oauth
```

Then add to your `opencode.json`:

```json
{
  "plugin": ["opencode-anthropic-oauth"]
}
```

The package root remains the V1 plugin factory.

## OpenCode V2 beta installation

V2 must load the explicit `./v2` entrypoint. Pin a package version compatible with your exact V2 build:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-anthropic-oauth/v2",
      "options": {
        "allowClaudeCliFallback": false,
        "allowV1AuthFallback": false
      }
    }
  ]
}
```

Version `0.5.0` targets `opencode2 v0.0.0-next-15329`, `@opencode-ai/plugin@0.0.0-next-15329`, and `effect@4.0.0-beta.83`. The V2 API is beta; retest loading, OAuth login, refresh, API-key bypass, native Anthropic requests, tools, and reload cleanup after every OpenCode upgrade.

Fallback to Claude CLI or V1 `auth.json` is disabled by default so an isolated V2 installation cannot silently read shared credentials. Enable either option only when that sharing is intentional. A configured V2 or environment API key always disables OAuth interception.

## OpenCode 2.0.0-alpha-3+ installation (v3, from source)

alpha-3 removed the `/v2` plugin subpath this package's V2 entrypoint imports
(`@opencode-ai/plugin` now exports only `.`, `./effect`, `./tui`, `./v1`,
`./*`), and its promise plugin bridge exposes `integration` consumer-only — an
OAuth method registered through it appears in the connect UI but its
`authorize`/`refresh` never run, so connecting fails with an empty HTTP 500.

The `./v3` entrypoint targets the Effect plugin surface instead (`{id, effect}`),
which is the only external surface that can register integration methods on
alpha-3. It depends only on `@ai-sdk/anthropic` and `effect` (no
`@opencode-ai/plugin`). Not yet in an npm release — build from source
(`npm run build && npm pack`), install the tarball into your opencode config
directory, and load it via an adapter file:

```ts
// ~/.config/opencode/plugins/anthropic-oauth.ts
export { default } from "opencode-anthropic-oauth/v3"
```

v3 also accepts a `claude setup-token` for headless hosts: export
`CLAUDE_CODE_OAUTH_TOKEN`, or store the `sk-ant-oat...` value with the
integration's API-key method — both are recognized as subscription credentials
and routed through the OAuth path (as a plain `x-api-key` they would 401).

**Status: upstreamed and merged.** shuvcode PR #349
(`shuvbotta/anthropic-claude-code`, merged as `ea19eba379`) adds native Claude
Pro/Max subscription support in-tree — OAuth method, setup-token env, and
request shaping at route construction, with none of this plugin's workarounds
(no loopback proxy, no global fetch patch, no sentinel key; those exist here
only because external plugins have no hook into LLM route construction). On a
shuvcode build containing that merge this plugin is unnecessary; it remains
useful for older hosts and for upstream opencode until an equivalent lands
there.

## Usage

1. Run `/connect` in OpenCode (or `oc auth login` from CLI)
2. Select **Anthropic** > **Claude Pro/Max**
3. Open the link in your browser and authorize
4. Paste the code back into OpenCode
5. Done — all Anthropic models are now available

## How it works

- Implements the OAuth PKCE flow directly against Anthropic's auth endpoints
- Opens your browser for authentication — you log in with your Claude account
- Exchanges the authorization code for access + refresh tokens
- **Auto-refreshes tokens** when they expire — no manual re-auth needed
- Sets the required API headers on Anthropic requests
- **Preserves prompt caching** for efficient token usage

V2's native Anthropic route currently has no complete request-auth plugin hook. The V2 entrypoint therefore installs a narrow, reversible fetch compatibility shim for `https://api.anthropic.com` requests carrying this plugin's sentinel or an Anthropic OAuth token. Real API keys, proxy endpoints, and unrelated requests bypass it.

## Changelog

### 0.4.1
- **Fixed high token consumption** — removed `cache_control` stripping that was disabling prompt caching
- Added `x-anthropic-billing-header` for proper token tracking
- Aligned beta flags with official Claude CLI plugin

### 0.4.0
- Added `?beta=true` URL parameter for OAuth compatibility
- Injected system identity prefix for claude-code beta
- Stripped `cache_control` (now removed in 0.4.1)

### 0.3.0
- Added auto token refresh via loader hook
- Background proactive refresh timer (5min intervals)

## Environment variable overrides

All OAuth parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable | Description |
|---|---|
| `ANTHROPIC_CLIENT_ID` | OAuth client ID |
| `ANTHROPIC_CLI_VERSION` | Claude CLI version for User-Agent |
| `ANTHROPIC_USER_AGENT` | Full User-Agent string (overrides version) |
| `ANTHROPIC_AUTHORIZE_URL` | OAuth authorization endpoint |
| `ANTHROPIC_TOKEN_URL` | OAuth token endpoint |
| `ANTHROPIC_REDIRECT_URI` | OAuth redirect URI |
| `ANTHROPIC_SCOPES` | OAuth scopes |
| `ANTHROPIC_BETA_FLAGS` | Anthropic beta feature flags |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## Disclaimer

This plugin uses Anthropic's public OAuth client ID to authenticate. Anthropic's Terms of Service (February 2026) state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
