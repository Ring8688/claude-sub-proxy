# Skill: setup-embedded

## Description

Embed claude-sub-proxy as an internal service within another project. Minimal footprint — 4 JS files + config, running on localhost with no external exposure.

## Trigger

Trigger this skill when the user wants to:
- Embed the proxy inside another project
- Use claude-sub-proxy as a library/internal service
- Add Claude API access to an existing app without a separate server
- "Integrate claude-sub-proxy into my project"

## Setup Guide

### Step 1: Verify Claude Code CLI

Check that credentials exist:

```bash
cat ~/.claude/.credentials.json
# Should contain claudeAiOauth.accessToken
```

If not authenticated, run `claude` to log in.

### Step 2: Choose Integration Method

**Option A — Copy source files (recommended):**

```bash
# From the claude-sub-proxy repo, copy these files into your project:
mkdir -p your-project/claude-proxy
cp src/server.js src/claude-executor.js src/format-bridge.js src/logger.js src/config.txt your-project/claude-proxy/
```

**Option B — Git submodule:**

```bash
git submodule add <repo-url> claude-proxy
```

### Step 3: Install Dependency

```bash
npm install @anthropic-ai/claude-agent-sdk
```

### Step 4: Configure via Environment Variables

For embedded use, set these environment variables in your app's startup:

| Variable | Recommended Value | Description |
|----------|------------------|-------------|
| `CSP_PORT` | `42069` (or any free port) | Proxy listening port |
| `CSP_HOST` | `127.0.0.1` | Localhost only — no external exposure |
| `CSP_LOG_LEVEL` | `WARN` | Quiet logging for embedded use |

No `CSP_PROXY_API_KEY` needed — the proxy runs on localhost as an internal service.

### Step 5: Start the Proxy

**Option A — Background process in your start script:**

```json
// package.json
{
  "scripts": {
    "start": "concurrently \"node claude-proxy/server.js\" \"your-app-start-command\""
  }
}
```

```bash
npm install concurrently --save-dev
```

**Option B — Programmatic start:**

```js
import { startServer } from './claude-proxy/server.js';
startServer();
```

**Option C — PM2:**

```bash
pm2 start claude-proxy/server.js --name claude-proxy
```

### Step 6: Connect from Your App

**Node.js:**

```js
const response = await fetch('http://127.0.0.1:42069/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello!' }]
  })
});
const data = await response.json();
```

**Python:**

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://127.0.0.1:42069",
    api_key="not-needed"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

**curl:**

```bash
curl -X POST http://127.0.0.1:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### Step 7: Verify

```bash
# Health check
curl -s http://127.0.0.1:42069/health
# → {"status":"ok","server":"claude-sub-proxy","timestamp":...}

# Auth check
curl -s http://127.0.0.1:42069/auth/status
# → {"authenticated":true,"source":"claude_credentials","expires_at":"..."}
```

## Key Points

- **Localhost only** — default `CSP_HOST=127.0.0.1`, no external exposure
- **Text-only mode** — `tools: []` by default, pure API proxy
- **No proxy_api_key needed** — inter-process communication on localhost is trusted
- **Minimal footprint** — 4 JS files + 1 config file + 1 npm dependency
