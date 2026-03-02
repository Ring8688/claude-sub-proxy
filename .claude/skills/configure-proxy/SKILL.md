# Skill: configure-proxy

## Description

Configure advanced options for claude-sub-proxy: model selection, system prompts, tool access, thinking tokens, logging, and network settings.

## Trigger

Trigger this skill when the user wants to:
- Change the default model
- Set a custom system prompt
- Enable/disable Claude Code tools
- Configure thinking tokens
- Adjust log level, port, or host
- "Configure claude-sub-proxy"
- "Change proxy settings"

## Configuration Methods

Two ways to set configuration, with environment variables taking priority:

| Priority | Method | Best For |
|----------|--------|----------|
| 1 (highest) | Environment variables (`CSP_*`) | Docker, CI/CD, systemd |
| 2 | `src/config.txt` | Direct Node.js installs |

### Full Configuration Reference

| config.txt key | Environment Variable | Default | Description |
|---------------|---------------------|---------|-------------|
| `port` | `CSP_PORT` | `42069` | Server listening port |
| `host` | `CSP_HOST` | Auto (`127.0.0.1` / `0.0.0.0` in Docker) | Bind address |
| `log_level` | `CSP_LOG_LEVEL` | `INFO` | Log verbosity |
| `model_default` | `CSP_MODEL_DEFAULT` | `claude-sonnet-4-6` | Default model |
| `proxy_api_key` | `CSP_PROXY_API_KEY` | *(empty)* | Proxy authentication key |
| `system_prompt` | `CSP_SYSTEM_PROMPT` | *(empty — SDK default)* | Custom system prompt |
| `tools_enabled` | `CSP_TOOLS_ENABLED` | `false` | Enable Claude Code tools |
| `max_thinking_tokens` | `CSP_MAX_THINKING_TOKENS` | *(empty)* | Default thinking budget |

---

## Configuration Details

### Model Selection

```bash
# Via environment variable
CSP_MODEL_DEFAULT=claude-opus-4-6 npm start

# Via config.txt
model_default=claude-opus-4-6
```

Available models depend on your subscription plan:

| Model | Plan Required |
|-------|--------------|
| `claude-opus-4-6` | MAX |
| `claude-sonnet-4-6` | Pro / MAX |
| `claude-haiku-4-5-20251001` | Pro / MAX |

Clients can override the default by specifying `model` in the request body.

### Log Level

```bash
CSP_LOG_LEVEL=DEBUG npm start
```

| Level | Use Case |
|-------|----------|
| `ERROR` | Production — only errors |
| `WARN` | Embedded use — errors + warnings |
| `INFO` | Default — general operational info |
| `DEBUG` | Development — request details, SDK params |
| `TRACE` | Troubleshooting — verbose SDK output |

### System Prompt

Override the default Claude Code system prompt for all requests:

```bash
CSP_SYSTEM_PROMPT="You are a helpful coding assistant. Always respond in JSON format." npm start
```

Or in `config.txt`:

```
system_prompt=You are a helpful coding assistant. Always respond in JSON format.
```

Request-level `system` parameter takes priority over this config.

### Tools (Claude Code Built-in Tools)

**WARNING:** Enabling tools gives Claude access to file operations, shell commands, and other Claude Code capabilities. Only enable if you understand the implications.

```bash
CSP_TOOLS_ENABLED=true npm start
```

| Value | Behavior |
|-------|----------|
| `false` (default) | `tools: []` — pure text API, no tool access |
| `true` | SDK default tools — file read/write, bash, etc. |

### Thinking Tokens

Set a default thinking budget for extended thinking:

```bash
CSP_MAX_THINKING_TOKENS=10000 npm start
```

Request-level `thinking.budget_tokens` takes priority over this config.

### Port & Host

```bash
# Custom port
CSP_PORT=8080 npm start

# Bind to all interfaces (for network access)
CSP_HOST=0.0.0.0 CSP_PORT=8080 npm start
```

Default host behavior:
- **Direct Node.js**: `127.0.0.1` (localhost only)
- **Docker**: `0.0.0.0` (all interfaces, auto-detected)

### Proxy API Key

Require authentication for all `/v1/messages` requests:

```bash
CSP_PROXY_API_KEY=my-secret-key npm start
```

Clients must provide the key via `x-api-key` header or `Authorization: Bearer` header.

---

## Docker Example (All Options)

```bash
docker run -d \
  -p 8080:8080 \
  -v ~/.claude:/root/.claude:rw \
  -e CSP_PORT=8080 \
  -e CSP_LOG_LEVEL=DEBUG \
  -e CSP_MODEL_DEFAULT=claude-opus-4-6 \
  -e CSP_PROXY_API_KEY=my-secret-key \
  -e CSP_SYSTEM_PROMPT="You are a concise technical assistant." \
  -e CSP_MAX_THINKING_TOKENS=5000 \
  claude-sub-proxy
```

## config.txt Example (All Options)

```
port=8080
host=127.0.0.1
log_level=DEBUG
model_default=claude-opus-4-6
proxy_api_key=my-secret-key
system_prompt=You are a concise technical assistant.
tools_enabled=false
max_thinking_tokens=5000
```
