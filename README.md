# claude-sub-proxy

**English** | **[中文](README_CN.md)**

Use your Claude.ai subscription (MAX/Pro) to call the Anthropic Messages API — powered by the Claude Code Agent SDK.

```
Your App  ──POST /v1/messages──▶  claude-sub-proxy (localhost:42069)  ──Agent SDK──▶  Claude Code Runtime
                                                                          │
                                                                  Auto credential management
                                                                 (~/.claude/.credentials.json)
```

## Quick Start

**Recommended: Use Claude Code for guided setup:**

```bash
cd claude-sub-proxy
claude
# Then tell Claude: "Help me set up claude-sub-proxy"
# Claude will ask about your use case and guide you through the best setup method:
#   - Embedded: integrate into an existing project
#   - Standalone: deploy as an independent service (Docker / Node.js)
#   - Configure: customize advanced options (model, system prompt, tools, etc.)
```

**Or set up manually:**

```bash
cd claude-sub-proxy
npm install        # Install Agent SDK dependency
npm start          # Start the server
```

**Prerequisites:** Run `claude` CLI at least once to authenticate (stores credentials at `~/.claude/.credentials.json`).

Once running, point your SDK's `base_url` to the proxy:

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:42069",
    api_key="not-needed"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## How It Works

Unlike v1 which was a reverse proxy with manual OAuth token management, v2 uses the [Claude Code Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) to run Claude Code as a runtime:

- **Authentication** is handled automatically — the SDK reads your Claude Code credentials
- **Streaming** uses the same `BetaRawMessageStreamEvent` format as the official API
- **Response format** is `BetaMessage` — directly compatible with the Messages API

## Docker

```bash
# Build
docker build -t claude-sub-proxy .

# Run with Claude Code credentials
# Note: rw is required — the SDK writes back refreshed tokens
docker run -d -p 42069:42069 -v ~/.claude:/root/.claude:rw claude-sub-proxy

# Run with proxy authentication
docker run -d -p 42069:42069 \
  -v ~/.claude:/root/.claude:rw \
  -e CSP_PROXY_API_KEY=your-secret-key \
  claude-sub-proxy
```

**Docker Compose (recommended for deployment):**

```bash
# Copy and edit the env file
cp .env.example .env
# Set CSP_PROXY_API_KEY in .env

# Start
docker compose up -d

# View logs
docker compose logs -f
```

## Proxy API Key Authentication

Set `proxy_api_key` in `src/config.txt` or `CSP_PROXY_API_KEY` environment variable to require authentication for all requests. When configured, clients must provide the key via `x-api-key` header or `Authorization: Bearer` header.

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://your-server:42069",
    api_key="your-proxy-key"   # matches proxy_api_key in config
)
```

- **Not configured** (default): open access
- **Configured**: all `/v1/messages` requests require a matching key, otherwise 401

## Configuration

Configuration can be set via `src/config.txt` or environment variables (`CSP_*` prefix). Environment variables take priority.

| config.txt key | Environment Variable | Default | Description |
|---------------|---------------------|---------|-------------|
| `port` | `CSP_PORT` | `42069` | Server listening port |
| `host` | `CSP_HOST` | Auto | `127.0.0.1` locally, `0.0.0.0` in Docker |
| `log_level` | `CSP_LOG_LEVEL` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE` |
| `model_default` | `CSP_MODEL_DEFAULT` | `claude-sonnet-4-6` | Default model when not specified in request |
| `proxy_api_key` | `CSP_PROXY_API_KEY` | *(empty)* | API key for proxy authentication (empty = open access) |
| `system_prompt` | `CSP_SYSTEM_PROMPT` | *(empty)* | Custom system prompt (request-level takes priority) |
| `tools_enabled` | `CSP_TOOLS_ENABLED` | `false` | Enable Claude Code built-in tools |
| `max_thinking_tokens` | `CSP_MAX_THINKING_TOKENS` | *(empty)* | Default thinking budget (request-level takes priority) |

## Supported Models

All models available through your Claude.ai subscription, including:

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`

Available models depend on your subscription plan (Pro / MAX).

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/messages` | Messages API (streaming & non-streaming) |
| GET | `/auth/status` | Check authentication status |
| GET | `/health` | Health check |

## Testing

```bash
# Non-streaming
curl -X POST http://localhost:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N -X POST http://localhost:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Count 1 to 5"}]}'
```

## FAQ

**How does authentication work?**
The Agent SDK automatically reads credentials from `~/.claude/.credentials.json` (created by `claude` CLI). Token refresh is handled internally by the SDK.

**Is it secure?**
- The server listens on `127.0.0.1` by default — inaccessible from external networks
- Credentials are managed by the Claude Code runtime, not stored by this proxy
- Set `proxy_api_key` to require authentication when exposing to a network

**What are the limitations compared to direct API access?**
- `temperature`, `top_p`, `top_k` parameters are not forwarded (managed by Claude Code runtime)
- `max_tokens` is managed by the runtime
- Multi-turn conversations are converted to a structured prompt format
- Each request spawns a Claude Code process (~1-2s overhead)

## Acknowledgements

- [Claude Code Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [nanoclaw](https://github.com/hmk/nanoclaw) - Minimal Claude Code proxy implementation
- [claude-code-proxy](https://github.com/nicekid1/claude-code-proxy) - Claude Code proxy reference implementation

## Disclaimer

For personal learning and research use only. Please comply with [Anthropic's Terms of Service](https://www.anthropic.com/terms).
