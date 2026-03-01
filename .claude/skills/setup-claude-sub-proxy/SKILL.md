# Skill: setup-claude-sub-proxy

## Description

搭建一个本地代理服务器，让你使用 Claude.ai 订阅账号（MAX/Pro）的 OAuth Token 来调用 Anthropic API，无需购买 API credits，也无需反代。

核心原理：通过 OAuth 2.0 PKCE 流程获取 claude.ai 的订阅 token，然后以该 token 向 `api.anthropic.com/v1/messages` 发送请求，伪装成 Claude Code 客户端，从而使用订阅额度。

## Trigger

当用户提到以下场景时触发此 skill：
- "使用订阅 token 调用 API"
- "不想用 API key，用 claude.ai 订阅"
- "搭建 claude sub 代理"
- "使用 MAX 订阅调 API"
- "claude-sub-proxy"

## 架构概览

```
用户应用  →  本地代理 (localhost:42069)  →  api.anthropic.com/v1/messages
                   ↕
            OAuth Token 管理
           (自动刷新, 本地存储)
```

## 项目结构

```
claude-sub-proxy/
├── .claude/skills/setup-claude-sub-proxy/SKILL.md  # 本文件
├── package.json
├── README.md
├── src/
│   ├── server.js           # HTTP 服务器入口 + OAuth 路由
│   ├── oauth-manager.js    # OAuth 2.0 PKCE 流程管理
│   ├── claude-request.js   # API 请求代理与 token 注入
│   ├── logger.js           # 日志工具
│   ├── config.txt          # 配置文件
│   └── static/
│       ├── login.html      # OAuth 登录页
│       └── callback.html   # 认证成功页
```

## 使用步骤

### 1. 安装与启动

```bash
cd claude-sub-proxy
npm install   # 无外部依赖，仅使用 Node.js 内置模块
npm start     # 启动代理服务器
```

### 2. OAuth 认证

启动后浏览器会自动打开登录页（或手动访问 `http://localhost:42069/auth/login`）：
1. 点击 "Open Authorization Page" 跳转到 claude.ai 授权
2. 在 claude.ai 登录并授权
3. 复制页面上显示的授权码（格式 `code#state`）
4. 粘贴到登录页并提交

Token 自动保存在 `~/.claude-sub-proxy/tokens.json`，过期前自动刷新。

### 3. 使用代理

将任何 Anthropic SDK 或兼容客户端指向 `http://localhost:42069`：

```python
import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:42069",
    api_key="not-needed"  # 可以填任意值
)

message = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## 关键技术点

### OAuth 2.0 PKCE 参数

| 参数 | 值 |
|------|-----|
| client_id | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` |
| authorize_url | `https://claude.ai/oauth/authorize` |
| token_url | `https://console.anthropic.com/v1/oauth/token` |
| redirect_uri | `https://console.anthropic.com/oauth/code/callback` |
| scope | `org:create_api_key user:profile user:inference` |
| PKCE method | S256 |

### 伪装 Claude Code 的关键 headers

```
anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14
anthropic-version: 2023-06-01
```

### System Prompt 注入

代理会在每个请求的 system 前注入：
```
You are Claude Code, Anthropic's official CLI for Claude.
```

### Token 回退优先级

1. 请求 header 中的 `x-api-key`（如果包含 `sk-ant`）
2. OAuth Manager 存储的 token（`~/.claude-sub-proxy/tokens.json`）
3. Claude Code 本地凭据（`~/.claude/.credentials.json`）

### 自动 Token 刷新

- Token 过期前 60 秒自动刷新
- 并发刷新请求自动合并（防止竞态条件）
- 401 响应自动触发刷新并重试

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/messages` | 代理到 Anthropic Messages API |
| GET | `/auth/login` | OAuth 登录页面 |
| GET | `/auth/get-url` | 获取 OAuth 授权 URL |
| GET | `/auth/callback` | OAuth 回调处理 |
| GET | `/auth/status` | 查看认证状态 |
| GET | `/auth/logout` | 注销（删除 token） |
| GET | `/health` | 健康检查 |

## 注意事项

- 仅供个人学习使用，请遵守 Anthropic 服务条款
- 代理默认监听 `127.0.0.1`（本机访问），Docker 中自动切换为 `0.0.0.0`
- Token 文件权限设置为 600（仅所有者可读写）
- 支持 SSE 流式响应透传

---

## 模块规格

### oauth-manager.js

单例模块，管理 OAuth 2.0 PKCE 认证流程和 token 生命周期。

**导出方式:** `module.exports = new OAuthManager()` (单例实例)

#### `generatePKCE() → { code_verifier: string, code_challenge: string, state: string }`

生成 PKCE 所需的三元组：
- `code_verifier`: `crypto.randomBytes(32).toString('base64url')`
- `code_challenge`: `SHA256(code_verifier).toString('base64url')`
- `state`: `crypto.randomBytes(32).toString('base64url')`

#### `buildAuthorizationURL(pkce) → string`

拼接完整的 OAuth 授权 URL。参数通过 `URLSearchParams` 序列化，包含：
`code=true`, `client_id`, `response_type=code`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`

#### `exchangeCodeForTokens(code, code_verifier, state) → Promise<{ access_token, refresh_token, expires_in }>`

向 token_url POST `grant_type=authorization_code`，附带 code、code_verifier、state、client_id、redirect_uri。

#### `refreshAccessToken() → Promise<response>`

用 refresh_token 刷新 access_token。**使用 singleton promise 锁**防止并发刷新：
- 如果 `this.refreshPromise` 已存在 → 直接 return 它
- 否则创建新 promise，完成后在 finally 中清除 `this.refreshPromise = null`
- 刷新成功后自动 `saveTokens()` 并更新 `this.cachedToken`

#### `getValidAccessToken() → Promise<string>`

获取有效 access_token，带 60 秒提前刷新：
1. 如果 `cachedToken` 存在且 `expires_at > Date.now() + 60000` → 返回缓存
2. 否则读 tokens.json，如果未过期 → 缓存并返回
3. 如果即将过期 → 调用 `refreshAccessToken()` → 返回新 token

#### `loadTokens() → object | null`

读取 `this.tokenPath` 文件，JSON.parse 返回。文件不存在时返回 `null`，不抛错。

#### `saveTokens(tokens) → void`

将 tokens 写入 `this.tokenPath`：
- 自动创建目录（`mkdirSync recursive`）
- `JSON.stringify(tokens, null, 2)` 写入
- 非 Windows 系统 `chmodSync(path, 0o600)`

#### `isAuthenticated() → boolean`

检查 tokens.json 是否存在 access_token 和 refresh_token。

#### `getTokenExpiration() → Date | null`

返回 `new Date(tokens.expires_at)`，无 token 返回 null。

#### `logout() → void`

删除 tokens.json 文件，清空 `cachedToken`。

#### 构造函数属性

```javascript
this.tokenPath = path.join(HOME, '.claude-sub-proxy', 'tokens.json')
this.cachedToken = null      // 内存中的 access_token 缓存
this.refreshPromise = null   // singleton promise 锁
```

---

### claude-request.js

处理单次 API 代理请求，包含 token 获取、请求构建、响应转发。

**导出方式:** `module.exports = ClaudeRequest` (类)

#### 构造函数 `new ClaudeRequest(req)`

- 检查 `req.headers['x-api-key']`，如果包含 `sk-ant` → 设置为 `ClaudeRequest.cachedToken`（加 `Bearer ` 前缀）
- 静态属性：`ClaudeRequest.cachedToken`、`ClaudeRequest.refreshPromise`

#### `getAuthToken() → Promise<string>`

三级 token 回退链：
1. `ClaudeRequest.cachedToken`（内存缓存，可能来自 x-api-key 覆盖）
2. `OAuthManager.getValidAccessToken()` → 返回 `Bearer ${token}`
3. `loadFromClaudeCodeCredentials()` → 读 `~/.claude/.credentials.json`

#### `loadFromClaudeCodeCredentials() → Promise<string>`

读取 `~/.claude/.credentials.json` 中的 `claudeAiOauth` 字段：
- 如果 `expiresAt - 10000 <= Date.now()` → 调用 `refreshTokenViaOAuth()` 刷新
- 否则返回 `Bearer ${oauth.accessToken}`

#### `refreshTokenViaOAuth(credentials, credentialsPath) → Promise<string>`

刷新 Claude Code 凭据文件中的 token（singleton promise 锁模式同上）：
- POST `console.anthropic.com/v1/oauth/token`，`grant_type=refresh_token`
- 成功后写回 credentials.json（注意：不格式化，`JSON.stringify(credentials)` 无缩进）
- finally 中清除 `ClaudeRequest.refreshPromise = null`

#### `processRequestBody(body) → object`

1. 在 body.system 数组最前面注入 system prompt（`unshift`）
2. 如果 body.system 是字符串 → 转为 `[systemPrompt, body.system]`
3. 如果无 body.system → 设为 `[systemPrompt]`
4. 调用 `stripTtlFromCacheControl(body)` 清洗

#### `stripTtlFromCacheControl(body) → object`

遍历 `body.system[]` 和 `body.messages[].content[]`，删除所有 `item.cache_control.ttl` 字段。

#### `makeRequest(body) → Promise<http.IncomingMessage>`

构建 HTTPS POST 到 `api.anthropic.com/v1/messages`：
- Headers: `Content-Type: application/json`, `Authorization: <token>`, `anthropic-version`, `anthropic-beta`
- 返回 Node.js `http.IncomingMessage` 对象（upstream response）

#### `handleResponse(res, body) → Promise<void>`

完整请求生命周期：
1. 调用 `makeRequest(body)`
2. 如果返回 401 → 清除 `cachedToken` → `loadOrRefreshToken()` → 重试一次
3. 复制 upstream response 的 statusCode 和所有 headers 到 client response
4. 调用 `streamResponse()` 转发内容

#### `streamResponse(res, claudeResponse) → void`

根据 content-type 分流：
- **SSE (`text/event-stream`)**: `claudeResponse.pipe(res)`（可选 debug stream 中间层）
  - `res.on('close')` → `claudeResponse.destroy()` 清理上游流
- **非流式**: buffer 所有 data → JSON.parse → 重新 stringify 发送
  - 移除 `content-encoding` header（处理 gzip 场景）

---

### server.js

HTTP 服务器入口，管理 OAuth 路由和 API 代理。

**导出方式:** `module.exports = { startServer }`

#### PKCE State 管理

```javascript
const pkceStates = new Map();  // Map<state_string, { code_verifier: string, created_at: number }>
const PKCE_EXPIRY_MS = 10 * 60 * 1000;  // 10 分钟过期
setInterval(cleanupExpiredPKCE, 60000);  // 每分钟清理
```

- `pkceStates.set(state, { code_verifier, created_at: Date.now() })` — 生成授权 URL 时存入
- `pkceStates.get(state)` — callback 中取出验证
- `pkceStates.delete(state)` — 验证后立即删除（用后即删）

#### 路由表

| 路由 | 处理逻辑 |
|------|----------|
| `GET /auth/login` | 返回 login.html 静态文件 |
| `GET /auth/get-url` | 生成 PKCE → 存入 pkceStates → 构建授权 URL → 返回 JSON `{ url, state }` |
| `GET /auth/callback` | 解析 code+state（支持 `manual_code=code#state` 格式）→ 验证 state → 交换 token → 存储 → 返回 callback.html |
| `GET /auth/status` | 返回 `{ authenticated: bool, expires_at: ISO_string }` |
| `GET /auth/logout` | 调用 `OAuthManager.logout()` → 返回 `{ success: true }` |
| `GET /health` | 返回 `{ status: 'ok', server: 'claude-sub-proxy', timestamp }` |
| `POST /v1/messages` | parseBody → new ClaudeRequest(req).handleResponse(res, body) |
| 其他 | 404 JSON |

#### 智能绑定

```javascript
const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');
```

Docker 检测：检查 `/.dockerenv` 文件或 `/proc/self/cgroup` 包含 `docker`/`containerd`。

#### 自动打开浏览器

首次启动且未认证时，1 秒延迟后调用平台对应命令：
- macOS: `open`
- Windows: `cmd /c start ""`
- Linux: `xdg-open`

#### CORS

允许的 headers: `Content-Type, Authorization, X-Requested-With, x-api-key, anthropic-version, anthropic-beta`

---

### logger.js

静态日志类，支持 5 级日志和 SSE debug stream。

**导出方式:** `module.exports = Logger` (类，全部静态方法)

- `Logger.init(config)` — 从 config 读取 log_level
- `Logger.getLogLevel()` — 返回数字 0-4 (ERROR=0, WARN=1, INFO=2, DEBUG=3, TRACE=4)
- `Logger.debug/info/warn/error(...args)` — 按级别输出
- `Logger.createDebugStream(label, textExtractor)` — 返回 Transform stream，DEBUG 级别时解析并打印 SSE 文本和 thinking 内容

---

## 关键数据结构

### Token 存储 (`~/.claude-sub-proxy/tokens.json`)

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "expires_at": 1709400000000
}
```

`expires_at` = `Date.now() + expires_in * 1000`（毫秒时间戳）

### Claude Code 凭据 (`~/.claude/.credentials.json`)

```json
{
  "claudeAiOauth": {
    "accessToken": "eyJ...",
    "refreshToken": "eyJ...",
    "expiresAt": 1709400000000
  }
}
```

注意字段名是 **camelCase**（accessToken vs access_token）。

### PKCE 内存状态

```
Map<state_string, { code_verifier: string, created_at: number }>
```

`created_at` 为 `Date.now()` 毫秒时间戳，10 分钟后过期清理。

---

## 关键算法伪代码

### 1. PKCE 生成

```
code_verifier = randomBytes(32) → base64url
code_challenge = SHA256(code_verifier) → base64url
state = randomBytes(32) → base64url
return { code_verifier, code_challenge, state }
```

### 2. Token 刷新锁 (Singleton Promise)

```
refreshAccessToken():
  if this.refreshPromise exists:
    return this.refreshPromise    // 复用进行中的刷新

  this.refreshPromise = async():
    try:
      tokens = loadTokens()
      payload = { grant_type: 'refresh_token', refresh_token, client_id }
      response = POST token_url with payload
      newTokens = { access_token, refresh_token (保留旧的如果新的为空), expires_at }
      saveTokens(newTokens)
      cachedToken = newTokens.access_token
      return response
    finally:
      this.refreshPromise = null  // 无论成功失败都释放锁

  return this.refreshPromise
```

### 3. 401 自动重试

```
handleResponse(res, body):
  claudeResponse = makeRequest(body)

  if claudeResponse.statusCode == 401:
    cachedToken = null              // 清除缓存
    newToken = loadOrRefreshToken() // 重新获取 token
    cachedToken = newToken
    retryResponse = makeRequest(body)  // 重试一次
    pipe retryResponse → res
    return

  pipe claudeResponse → res        // 正常转发
```

### 4. SSE 透传

```
streamResponse(res, claudeResponse):
  contentType = claudeResponse.headers['content-type']

  if contentType contains 'text/event-stream':
    // 流式：直接 pipe
    claudeResponse.on('error') → 返回 500
    res.on('close') → claudeResponse.destroy()  // 客户端断开时清理
    if DEBUG级别:
      claudeResponse.pipe(debugStream).pipe(res)
    else:
      claudeResponse.pipe(res)
  else:
    // 非流式：buffer 后转发
    res.removeHeader('content-encoding')  // 处理 gzip
    buffer all data
    JSON.parse → JSON.stringify → res.end()
```

### 5. 客户端断开清理

```
// 在 SSE 流式模式中
res.on('close', () => {
  // 客户端断开连接
  if (!claudeResponse.destroyed) {
    claudeResponse.destroy()  // 销毁上游连接，避免资源泄漏
  }
})
```

---

## 边界情况清单

| 场景 | 处理方式 |
|------|----------|
| **并发刷新** | singleton promise 模式：多个请求同时触发刷新时共享同一个 promise |
| **客户端断开** | `res.on('close')` 中调用 `claudeResponse.destroy()` 销毁上游流 |
| **手动 code 输入** | 支持 `manual_code=code#state` 格式，用 `split('#')` 解析，长度不为 2 则报错 |
| **cache_control.ttl 清洗** | 遍历 `system[]` 和 `messages[].content[]`，删除每个元素的 `cache_control.ttl` |
| **gzip 响应** | 非流式模式中 `res.removeHeader('content-encoding')`，避免客户端解压失败 |
| **CORS** | 允许 `x-api-key, anthropic-version, anthropic-beta` 等自定义 headers |
| **PKCE state 过期** | 10 分钟后清理（每分钟扫描 Map），验证成功后立即 delete |
| **token 文件不存在** | `loadTokens()` 返回 `null`，不抛错不 log error |
| **x-api-key 含 sk-ant** | 直接用作 Bearer token 覆盖缓存，优先级最高 |
| **system 为字符串** | `processRequestBody` 转为数组 `[systemPrompt, originalString]` |
| **token 请求超时** | `req.setTimeout(10000)` → destroy → reject |
| **Docker 环境** | 自动绑定 `0.0.0.0`，通过 `/.dockerenv` 或 cgroup 检测 |

---

## HTML 页面行为

### login.html

**页面加载时：**
- `fetch('/auth/status')` → 如果 `data.authenticated` 为 true → 显示绿色状态框，内容为过期时间

**点击 "Open Authorization Page" 按钮：**
- `e.preventDefault()` → `fetch('/auth/get-url')` → `data.url` → `window.open(url, '_blank')` 新窗口打开

**表单提交：**
- `<form action="/auth/callback" method="GET">` → 将 `manual_code` 作为 query 参数
- input name 为 `manual_code`，用户粘贴 `code#state` 格式

### callback.html

纯静态成功页，无 JavaScript 逻辑：
- 显示绿色对勾 + "Authentication Successful!"
- info-box 说明：tokens 已保存、会自动刷新、代理已就绪
- 显示 curl 测试命令示例
- 底部显示 token 存储路径：`~/.claude-sub-proxy/tokens.json`
