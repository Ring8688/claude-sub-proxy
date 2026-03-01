# claude-sub-proxy

用 Claude.ai 订阅账号（MAX/Pro）的 OAuth Token 调用 Anthropic API，无需 API credits。

```
你的应用  ──POST /v1/messages──▶  本地代理 (localhost:42069)  ──Bearer token──▶  api.anthropic.com
                                        │
                                  OAuth Token 管理
                                 (自动刷新, 本地存储)
```

## 快速开始

```bash
cd claude-sub-proxy
npm start          # 启动代理，浏览器自动打开认证页
```

1. 点击 **Open Authorization Page** 跳转 claude.ai 授权
2. 登录并授权后，复制页面上的授权码（格式 `code#state`）
3. 粘贴到登录页提交

认证完成后，将 SDK 的 `base_url` 指向代理即可：

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:42069",
    api_key="not-needed"
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## 配置

编辑 `src/config.txt`：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `port` | `42069` | 代理监听端口 |
| `host` | 自动 | 为空时本机 `127.0.0.1`，Docker 中 `0.0.0.0` |
| `log_level` | `INFO` | `ERROR` / `WARN` / `INFO` / `DEBUG` / `TRACE` |
| `auto_open_browser` | `true` | 首次未认证时自动打开浏览器 |

## 支持的模型

所有通过 Claude.ai 订阅可用的模型均可使用，包括：

- `claude-sonnet-4-20250514`
- `claude-opus-4-20250514`
- `claude-haiku-3-5-20241022`

具体可用模型取决于你的订阅计划（Pro / MAX）。

## 常见问题

**Token 过期怎么办？**
代理会在 token 过期前 60 秒自动刷新，无需手动操作。如果 refresh token 也失效，重新访问 `/auth/login` 认证即可。

**能用多久？**
只要你的 Claude.ai 订阅有效且 refresh token 未被撤销，代理可以持续工作。

**安全性？**
- Token 存储在 `~/.claude-sub-proxy/tokens.json`，文件权限 `600`（仅所有者可读写）
- 代理默认仅监听 `127.0.0.1`，外部无法访问
- 不会将你的 token 发送到除 `api.anthropic.com` 以外的任何地方

**请求头需要传 API key 吗？**
不需要。`x-api-key` 可填任意值或留空。但如果传入包含 `sk-ant` 的真实 API key，代理会直接使用该 key（适合混合使用场景）。

## 致谢

本项目灵感来自：
- [nanoclaw](https://github.com/hmk/nanoclaw) - 最小化 Claude Code 代理实现
- [claude-code-proxy](https://github.com/nicekid1/claude-code-proxy) - Claude Code 代理参考实现

## 免责声明

仅供个人学习研究使用，请遵守 [Anthropic 服务条款](https://www.anthropic.com/terms)。
