# Skill: setup-standalone

## Description

Deploy claude-sub-proxy as a standalone service, exposing a URL + API key for external applications to consume. Supports Docker and direct Node.js deployment.

## Trigger

Trigger this skill when the user wants to:
- Deploy the proxy as an independent service
- Set up a shared proxy server for multiple clients
- "Deploy claude-sub-proxy on a server"
- "Set up claude-sub-proxy with Docker"
- Run the proxy as a long-running service with authentication

## Setup Guide

### Step 1: Verify Claude Code CLI

Check that credentials exist on the target machine:

```bash
cat ~/.claude/.credentials.json
# Should contain claudeAiOauth.accessToken
```

If not authenticated, run `claude` to log in.

### Step 2: Generate a Proxy API Key

Strongly recommended for standalone deployment — protects the proxy from unauthorized access:

```bash
openssl rand -hex 32
# Example output: a1b2c3d4e5f6...
```

Save this key — you'll use it as `CSP_PROXY_API_KEY` and give it to clients.

### Step 3: Choose Deployment Method

---

#### Option A: Docker (Recommended)

**Build the image:**

```bash
cd claude-sub-proxy
docker build -t claude-sub-proxy .
```

**Run with environment variables:**

```bash
docker run -d \
  --name claude-sub-proxy \
  -p 42069:42069 \
  -v ~/.claude:/root/.claude:ro \
  -e CSP_PROXY_API_KEY=your-generated-key \
  -e CSP_LOG_LEVEL=INFO \
  claude-sub-proxy
```

**docker-compose.yml template:**

```yaml
version: '3.8'
services:
  claude-sub-proxy:
    build: .
    ports:
      - "42069:42069"
    volumes:
      - ~/.claude:/root/.claude:ro
    environment:
      - CSP_PROXY_API_KEY=your-generated-key
      - CSP_LOG_LEVEL=INFO
      - CSP_MODEL_DEFAULT=claude-sonnet-4-6
    restart: unless-stopped
```

```bash
docker compose up -d
```

---

#### Option B: Direct Node.js

**Install and start:**

```bash
cd claude-sub-proxy
npm install
CSP_PROXY_API_KEY=your-generated-key npm start
```

**PM2 (production):**

```bash
npm install -g pm2

CSP_PROXY_API_KEY=your-generated-key \
CSP_LOG_LEVEL=INFO \
pm2 start src/server.js --name claude-sub-proxy

pm2 save
pm2 startup  # Auto-start on reboot
```

**systemd service:**

```ini
# /etc/systemd/system/claude-sub-proxy.service
[Unit]
Description=Claude Sub Proxy
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/claude-sub-proxy
Environment=CSP_PROXY_API_KEY=your-generated-key
Environment=CSP_LOG_LEVEL=INFO
ExecStart=/usr/bin/node src/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now claude-sub-proxy
```

### Step 4: Verify Deployment

```bash
# Health check
curl -s http://localhost:42069/health
# → {"status":"ok","server":"claude-sub-proxy","timestamp":...}

# Auth check (with proxy key)
curl -s http://localhost:42069/auth/status
# → {"authenticated":true,"source":"claude_credentials","expires_at":"..."}

# Test message (with proxy key)
curl -X POST http://localhost:42069/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-generated-key" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'
```

### Step 5: Client Connection Info

Give clients:
- **Base URL**: `http://your-server:42069`
- **API Key**: the `CSP_PROXY_API_KEY` you generated

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://your-server:42069",
    api_key="your-generated-key"
)

message = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Key Points

- **Always set `CSP_PROXY_API_KEY`** — standalone services should require authentication
- **Docker mounts credentials read-only** (`-v ~/.claude:/root/.claude:ro`)
- **Host auto-detection** — Docker containers automatically bind `0.0.0.0`
- **Restart policy** — use `restart: unless-stopped` (Docker) or `Restart=on-failure` (systemd)
