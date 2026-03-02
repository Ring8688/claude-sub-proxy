# Skill: setup-claude-sub-proxy

## Description

Set up a local proxy server that uses the Claude Code Agent SDK to expose a standard Messages API endpoint — powered by your Claude.ai subscription (MAX/Pro), no API credits needed.

Core principle: The Agent SDK handles authentication automatically by reading Claude Code credentials (`~/.claude/.credentials.json`), then processes requests through the Claude Code runtime.

## Trigger

Trigger this skill when the user mentions scenarios such as:
- "Use a subscription token to call the API"
- "Don't want to use an API key, use claude.ai subscription instead"
- "Set up a claude sub proxy"
- "Use MAX subscription to call the API"
- "claude-sub-proxy"
- "Help me set up" / "帮我设置"

## Guided Setup Flow

When this skill is triggered, **ask the user which setup mode they need** before proceeding:

1. **Embedded** (`.claude/skills/setup-embedded/SKILL.md`) — Integrate into an existing project as an internal service. Best for: adding Claude API to your own app, localhost-only, minimal footprint.

2. **Standalone** (`.claude/skills/setup-standalone/SKILL.md`) — Deploy as an independent service with authentication. Best for: shared team proxy, Docker deployment, exposing to a network.

3. **Configure** (`.claude/skills/configure-proxy/SKILL.md`) — Customize advanced options on an existing installation. Best for: changing model, system prompt, enabling tools, tuning thinking tokens.

4. **Quick start** — Just `npm install && npm start` with defaults. Best for: trying it out locally in 30 seconds.

Ask the user something like: "How do you plan to use claude-sub-proxy?" and present these options. Then follow the corresponding skill guide.

## Architecture Overview

```
User App  →  Local Proxy (localhost:42069)  →  Agent SDK  →  Claude Code Runtime
                   ↕                                ↕
              HTTP Server                  Auto credential management
         (Messages API compatible)      (~/.claude/.credentials.json)
```

## Project Structure

```
claude-sub-proxy/
├── .claude/skills/
│   ├── setup-claude-sub-proxy/SKILL.md  # This file
│   ├── setup-embedded/SKILL.md          # Embedded integration guide
│   ├── setup-standalone/SKILL.md        # Standalone deployment guide
│   └── configure-proxy/SKILL.md         # Advanced configuration
├── package.json              # ESM project with @anthropic-ai/claude-agent-sdk
├── README.md / README_CN.md
├── Dockerfile
├── src/
│   ├── server.js             # HTTP server entry + route handling
│   ├── claude-executor.js    # Agent SDK query() wrapper (streaming & non-streaming)
│   ├── format-bridge.js      # Messages API ↔ SDK format conversion
│   ├── logger.js             # Logging utility
│   └── config.txt            # Configuration file
```

## Usage Steps

### 1. Install & Start

```bash
cd claude-sub-proxy
npm install   # Install Agent SDK dependency
npm start     # Start the server
```

### 2. Authentication

Authentication is automatic. Run `claude` CLI at least once to authenticate (creates `~/.claude/.credentials.json`).

### 3. Use the Proxy

Point any Anthropic SDK or compatible client to `http://localhost:42069`:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:42069",
    api_key="not-needed"  # Can be any value
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Key Technical Details

### Agent SDK Integration

The proxy uses `query()` from `@anthropic-ai/claude-agent-sdk` with these settings:
- `tools: []` — No built-in tools (pure API proxy, unless `tools_enabled=true`)
- `maxTurns: 1` — Single conversation turn
- `persistSession: false` — No session persistence
- `includePartialMessages: true` — For SSE streaming

### Authentication

Claude Code credentials (`~/.claude/.credentials.json`) — auto-managed by SDK. Token refresh is handled internally.

### Format Conversion

**Input (Messages API → SDK):**
- Single message: content becomes the `prompt` string
- Multi-turn: prior messages formatted as `<conversation_history>` XML, last message as prompt
- `body.system` → `options.systemPrompt`
- `body.model` → `options.model`
- `body.thinking.budget_tokens` → `options.maxThinkingTokens`

**Output (SDK → Messages API):**
- Non-streaming: `SDKAssistantMessage.message` (BetaMessage) returned as JSON
- Streaming: `SDKPartialAssistantMessage.event` (BetaRawMessageStreamEvent) forwarded as SSE

### Stream Event Types

The SDK yields `BetaRawMessageStreamEvent` — identical to the Anthropic API SSE format:
- `message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Messages API (streaming & non-streaming) |
| GET | `/auth/status` | Check authentication status |
| GET | `/health` | Health check |

## Configuration

Two methods — environment variables (`CSP_*` prefix) take priority over `src/config.txt`:

| config.txt key | Environment Variable | Default | Description |
|---------------|---------------------|---------|-------------|
| `port` | `CSP_PORT` | `42069` | Server listening port |
| `host` | `CSP_HOST` | Auto | `127.0.0.1` locally, `0.0.0.0` in Docker |
| `log_level` | `CSP_LOG_LEVEL` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE` |
| `model_default` | `CSP_MODEL_DEFAULT` | `claude-sonnet-4-6` | Default model when not specified in request |
| `proxy_api_key` | `CSP_PROXY_API_KEY` | *(empty)* | Proxy authentication key (empty = open access) |
| `system_prompt` | `CSP_SYSTEM_PROMPT` | *(empty)* | Custom system prompt (request-level takes priority) |
| `tools_enabled` | `CSP_TOOLS_ENABLED` | `false` | Enable Claude Code built-in tools |
| `max_thinking_tokens` | `CSP_MAX_THINKING_TOKENS` | *(empty)* | Default thinking budget (request-level takes priority) |

## Notes

- For personal learning use only, please comply with Anthropic's Terms of Service
- The server listens on `127.0.0.1` (localhost only) by default; auto-switches to `0.0.0.0` in Docker
- Each request spawns a Claude Code process (~1-2s overhead)
- `temperature`, `top_p`, `top_k`, `max_tokens` are managed by the Claude Code runtime

---

## Module Specifications

### format-bridge.js

Handles conversion between Messages API format and Agent SDK parameters.

**Exports:** Named exports (ESM)

#### `extractTextContent(content) → string`

Extracts text from message content. Handles both string content and content block arrays (filters for `type: 'text'`).

#### `requestToSDKParams(body, config) → { prompt: string, options: object }`

Converts a Messages API request body to SDK `query()` parameters:
- Builds prompt from messages array (single or multi-turn with `<conversation_history>` XML)
- Maps `body.system` to `options.systemPrompt`
- Maps `body.model` to `options.model`
- Maps `body.thinking.budget_tokens` to `options.maxThinkingTokens`
- Applies config-level `system_prompt`, `tools_enabled`, `max_thinking_tokens`
- Sets `tools: []`, `maxTurns: 1`, `persistSession: false`

#### `sdkMessageToAPIResponse(sdkMsg) → object`

Extracts `BetaMessage` from `SDKAssistantMessage.message`. Returns a Messages API compatible response with `id`, `type`, `role`, `content`, `model`, `stop_reason`, `usage`.

#### `streamEventToSSE(sdkMsg) → string`

Converts `SDKPartialAssistantMessage` to an SSE line: `event: {type}\ndata: {json}\n\n`

---

### claude-executor.js

Wraps Agent SDK `query()` calls for HTTP request handling.

**Exports:** Named exports (ESM)

#### `executeNonStreaming(body, config) → Promise<object>`

1. Calls `requestToSDKParams(body, config)` to get prompt + options
2. Sets `includePartialMessages: false`
3. Iterates SDK generator, captures last `assistant` message
4. Returns `sdkMessageToAPIResponse(lastAssistantMessage)`
5. Throws on `assistant.error` or missing response

#### `executeStreaming(body, res, config) → Promise<void>`

1. Calls `requestToSDKParams(body, config)` to get prompt + options
2. Sets `includePartialMessages: true`
3. Writes SSE headers (`text/event-stream`)
4. Sets up abort on `res.on('close')`
5. Iterates SDK generator, writes `stream_event` as SSE lines
6. On error after headers sent: writes SSE error event
7. Calls `res.end()` in finally block

---

### server.js

HTTP server entry point with simplified routing.

**Export:** `{ startServer }` (ESM)

#### Route Table

| Route | Handler |
|-------|---------|
| `OPTIONS *` | CORS preflight response |
| `GET /health` | Returns `{ status: 'ok', server, timestamp }` |
| `GET /auth/status` | Checks credentials file, returns `{ authenticated, source, expires_at }` |
| `POST /v1/messages` | parseBody → authenticate → streaming/non-streaming executor |
| Other | 404 JSON |

#### `loadConfig() → object`

Loads `src/config.txt`, then applies `CSP_*` environment variable overrides.

#### `checkClaudeCredentials() → { authenticated: boolean, expires_at?: string }`

Reads `~/.claude/.credentials.json`, checks for `claudeAiOauth.accessToken`.

#### `authenticateRequest(req, config) → { ok: boolean, error?: string }`

Validates request against `proxy_api_key`. Open access when not configured.

---

### logger.js

Static logging class with 5 log levels. ESM export.

**Export:** `export default Logger`

---

## Key Data Structures

### Claude Code Credentials (`~/.claude/.credentials.json`)

```json
{
  "claudeAiOauth": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresAt": 1709400000000
  }
}
```

Read automatically by the Agent SDK. Token refresh is handled by the SDK internally.

---

## Edge Cases Checklist

| Scenario | Handling |
|----------|----------|
| **No credentials** | SDK throws auth error → returned as 500 to client |
| **Client disconnect** | `res.on('close')` aborts SDK query via AbortController |
| **Multi-turn messages** | Prior messages formatted as `<conversation_history>` XML context |
| **Streaming error** | After headers sent: SSE error event written; before: 500 JSON |
| **System prompt** | Request-level > config-level > SDK default |
| **Thinking tokens** | Request-level > config-level |
| **Docker environment** | Auto-binds `0.0.0.0` (detected via `/.dockerenv` or cgroup) |
| **CORS** | Allows `Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta` |
