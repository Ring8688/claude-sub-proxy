import http from 'http';
import url from 'url';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import Logger from './logger.js';
import { executeNonStreaming, executeStreaming } from './claude-executor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const config = {};
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');

    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });

    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.warn(`Using default config: ${error.message}`);
  }

  // Environment variable overrides (CSP_ prefix)
  const envMap = {
    CSP_PORT: 'port',
    CSP_HOST: 'host',
    CSP_LOG_LEVEL: 'log_level',
    CSP_MODEL_DEFAULT: 'model_default',
    CSP_PROXY_API_KEY: 'proxy_api_key',
    CSP_SYSTEM_PROMPT: 'system_prompt',
    CSP_TOOLS_ENABLED: 'tools_enabled',
    CSP_MAX_THINKING_TOKENS: 'max_thinking_tokens',
  };
  for (const [envKey, configKey] of Object.entries(envMap)) {
    if (process.env[envKey]) config[configKey] = process.env[envKey];
  }

  // Init logger with final config (after all overrides applied)
  Logger.init(config);

  return config;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         '127.0.0.1';
}

/**
 * Check if Claude Code credentials exist (~/.claude/.credentials.json).
 * The Agent SDK reads these automatically for authentication.
 */
function checkClaudeCredentials() {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credentialsPath)) return { authenticated: false };
    const data = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const oauth = data.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return { authenticated: false };
    return {
      authenticated: true,
      expires_at: oauth.expiresAt ? new Date(oauth.expiresAt).toISOString() : null,
    };
  } catch {
    return { authenticated: false };
  }
}

/**
 * Authenticate incoming request against proxy_api_key config.
 * - If proxy_api_key is not configured: open access
 * - If configured: require matching key via x-api-key or Authorization: Bearer
 */
function authenticateRequest(req, config) {
  const proxyKey = config.proxy_api_key;
  if (!proxyKey) return { ok: true };

  const xApiKey = req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const providedKey = xApiKey || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null);

  if (!providedKey) return { ok: false, error: 'Missing API key' };
  if (providedKey === proxyKey) return { ok: true };

  return { ok: false, error: 'Invalid API key' };
}

function isRunningInDocker() {
  if (fs.existsSync('/.dockerenv')) return true;
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch {
    return false;
  }
}

async function handleRequest(req, res, config) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname} from ${clientIP}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // --- Health Check ---
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', server: 'claude-sub-proxy', timestamp: Date.now() }));
    return;
  }

  // --- Auth Status (checks Claude Code credentials) ---
  if (pathname === '/auth/status' && req.method === 'GET') {
    const credStatus = checkClaudeCredentials();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authenticated: credStatus.authenticated,
      source: credStatus.authenticated ? 'claude_credentials' : 'none',
      expires_at: credStatus.expires_at,
    }));
    return;
  }

  // --- Messages API ---
  if (req.method === 'POST' && pathname === '/v1/messages') {
    const auth = authenticateRequest(req, config);
    if (!auth.ok) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: auth.error }
      }));
      return;
    }

    try {
      const body = await parseBody(req);
      Logger.debug(`Incoming request (${JSON.stringify(body).length} bytes)`);

      if (body.stream) {
        await executeStreaming(body, res, config);
      } else {
        const response = await executeNonStreaming(body, config);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    } catch (error) {
      Logger.error('Request error:', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: error.message }
        }));
      }
    }
    return;
  }

  // --- 404 ---
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function startServer() {
  const config = loadConfig();

  const server = http.createServer((req, res) => handleRequest(req, res, config));
  const port = parseInt(config.port) || 42069;
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info(`claude-sub-proxy v2 listening on ${host}:${port}`);
    Logger.info('  Powered by Claude Code Agent SDK');
    Logger.info('');

    // Check authentication sources
    const credStatus = checkClaudeCredentials();

    Logger.info('Authentication:');
    if (credStatus.authenticated) {
      Logger.info('  Claude Code credentials found (~/.claude/.credentials.json)');
      if (credStatus.expires_at) {
        Logger.info(`  Token expires: ${credStatus.expires_at}`);
      }
    } else {
      Logger.info('  No credentials found.');
      Logger.info('  Run "claude" CLI to authenticate.');
    }

    if (config.proxy_api_key) {
      Logger.info('');
      Logger.info('Proxy API Key: configured (authentication required)');
    }

    Logger.info('');
    Logger.info('Endpoint: POST /v1/messages');
    Logger.info(`Example: curl -X POST http://localhost:${port}/v1/messages \\`);
    Logger.info('  -H "Content-Type: application/json" \\');
    Logger.info(`  -d '{"model":"claude-sonnet-4-6","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`);
    Logger.info('');
  });

  const shutdown = () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startServer();
}

export { startServer };
