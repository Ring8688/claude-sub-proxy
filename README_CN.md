# claude-sub-proxy

**[English](README.md)** | **中文**

用 Claude.ai 订阅账号（MAX/Pro）调用 Anthropic Messages API —— 基于 Claude Code Agent SDK。

```
你的应用  ──POST /v1/messages──▶  claude-sub-proxy (localhost:42069)  ──Agent SDK──▶  Claude Code 运行时
                                                                          │
                                                                    自动凭据管理
                                                                 (~/.claude/.credentials.json)
```

## 快速开始

**推荐：使用 Claude Code 引导式安装：**

```bash
cd claude-sub-proxy
claude
# 然后告诉 Claude："帮我设置 claude-sub-proxy"
# Claude 会询问你的使用场景，并引导你选择最合适的安装方式：
#   - 嵌入式：集成到现有项目中
#   - 独立部署：作为独立服务运行（Docker / Node.js）
#   - 高级配置：自定义模型、系统提示词、工具开关等
```

**或手动安装：**

```bash
cd claude-sub-proxy
npm install        # 安装 Agent SDK 依赖
npm start          # 启动服务器
```

**前置条件：** 先运行一次 `claude` CLI 完成登录（凭据保存在 `~/.claude/.credentials.json`）。

启动后，将 SDK 的 `base_url` 指向代理即可：

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

## 工作原理

与 v1 的反向代理 + 手动 OAuth Token 管理不同，v2 使用 [Claude Code Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) 将 Claude Code 作为运行时：

- **认证** 自动处理 —— SDK 读取 Claude Code 凭据
- **流式输出** 使用与官方 API 相同的 `BetaRawMessageStreamEvent` 格式
- **响应格式** 为 `BetaMessage` —— 与 Messages API 直接兼容

## Docker 部署

```bash
# 构建镜像
docker build -t claude-sub-proxy .

# 使用 Claude Code 凭据运行
# 注意：必须使用 rw —— SDK 刷新 token 后需要写回
docker run -d -p 42069:42069 -v ~/.claude:/root/.claude:rw claude-sub-proxy

# 使用代理认证运行
docker run -d -p 42069:42069 \
  -v ~/.claude:/root/.claude:rw \
  -e CSP_PROXY_API_KEY=your-secret-key \
  claude-sub-proxy
```

**Docker Compose（推荐部署方式）：**

```bash
# 复制并编辑环境变量文件
cp .env.example .env
# 在 .env 中设置 CSP_PROXY_API_KEY

# 启动
docker compose up -d

# 查看日志
docker compose logs -f
```

## 代理 API Key 认证

在 `src/config.txt` 中设置 `proxy_api_key` 或通过 `CSP_PROXY_API_KEY` 环境变量配置，可为所有请求启用认证。配置后，客户端必须通过 `x-api-key` 请求头或 `Authorization: Bearer` 请求头提供匹配的 key。

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://your-server:42069",
    api_key="your-proxy-key"   # 与配置中的 proxy_api_key 匹配
)
```

- **未配置**（默认）：开放访问
- **已配置**：所有 `/v1/messages` 请求需要匹配的 key，否则返回 401

## 配置

通过 `src/config.txt` 或环境变量（`CSP_*` 前缀）配置。环境变量优先级更高。

| config.txt 键 | 环境变量 | 默认值 | 说明 |
|--------------|---------|--------|------|
| `port` | `CSP_PORT` | `42069` | 服务器监听端口 |
| `host` | `CSP_HOST` | 自动 | 本机 `127.0.0.1`，Docker 中 `0.0.0.0` |
| `log_level` | `CSP_LOG_LEVEL` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE` |
| `model_default` | `CSP_MODEL_DEFAULT` | `claude-sonnet-4-6` | 请求未指定模型时的默认模型 |
| `proxy_api_key` | `CSP_PROXY_API_KEY` | *（空）* | 代理认证 API key（空则开放访问） |
| `system_prompt` | `CSP_SYSTEM_PROMPT` | *（空）* | 自定义系统提示词（请求级优先） |
| `tools_enabled` | `CSP_TOOLS_ENABLED` | `false` | 启用 Claude Code 内置工具 |
| `max_thinking_tokens` | `CSP_MAX_THINKING_TOKENS` | *（空）* | 默认思考 token 预算（请求级优先） |

## 支持的模型

所有通过 Claude.ai 订阅可用的模型均可使用，包括：

- `claude-opus-4-6`
- `claude-sonnet-4-6`
- `claude-haiku-4-5-20251001`

具体可用模型取决于你的订阅计划（Pro / MAX）。

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | Messages API（支持流式和非流式） |
| GET | `/auth/status` | 检查认证状态 |
| GET | `/health` | 健康检查 |

## 测试

```bash
# 非流式
curl -X POST http://localhost:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'

# 流式
curl -N -X POST http://localhost:42069/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Count 1 to 5"}]}'
```

## 常见问题

**认证如何工作？**
Agent SDK 自动读取 `~/.claude/.credentials.json`（由 `claude` CLI 创建）中的凭据。Token 刷新由 SDK 内部处理。

**安全性？**
- 服务器默认仅监听 `127.0.0.1`，外部无法访问
- 凭据由 Claude Code 运行时管理，本代理不存储任何凭据
- 暴露到网络时，建议设置 `proxy_api_key` 要求认证

**与直接 API 访问相比有什么限制？**
- `temperature`、`top_p`、`top_k` 参数不会透传（由 Claude Code 运行时管理）
- `max_tokens` 由运行时管理
- 多轮对话会转换为结构化 prompt 格式
- 每个请求会启动一个 Claude Code 进程（约 1-2 秒额外开销）

## 致谢

- [Claude Code Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [nanoclaw](https://github.com/hmk/nanoclaw) - 最小化 Claude Code 代理实现
- [claude-code-proxy](https://github.com/nicekid1/claude-code-proxy) - Claude Code 代理参考实现

## 免责声明

仅供个人学习研究使用，请遵守 [Anthropic 服务条款](https://www.anthropic.com/terms)。
