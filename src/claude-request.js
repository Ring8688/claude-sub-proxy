const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Logger = require('./logger');
const OAuthManager = require('./oauth-manager');

class ClaudeRequest {
  static cachedToken = null;
  static refreshPromise = null;

  constructor(req = null) {
    this.API_URL = 'https://api.anthropic.com/v1/messages';
    this.VERSION = '2023-06-01';
    this.BETA_HEADER = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

    // Allow explicit API key passthrough via x-api-key header
    const apiKey = req?.headers?.['x-api-key'];
    if (apiKey && apiKey.includes('sk-ant')) {
      Logger.debug('Using x-api-key as token, replacing cache');
      ClaudeRequest.cachedToken = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
    }
  }

  /**
   * Strip TTL from cache_control to avoid unsupported parameter errors.
   */
  stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') return body;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;
      contentArray.forEach(item => {
        if (item?.cache_control?.ttl) {
          delete item.cache_control.ttl;
          Logger.debug('Removed ttl from cache_control');
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }
    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }
    return body;
  }

  /**
   * Get authentication token with fallback chain:
   * 1. Cached token (from x-api-key or previous auth)
   * 2. OAuth Manager stored tokens
   * 3. Claude Code local credentials (~/.claude/.credentials.json)
   */
  async getAuthToken() {
    if (ClaudeRequest.cachedToken) return ClaudeRequest.cachedToken;
    const token = await this.loadOrRefreshToken();
    ClaudeRequest.cachedToken = token;
    return token;
  }

  async loadOrRefreshToken() {
    try {
      if (OAuthManager.isAuthenticated()) {
        Logger.debug('Using OAuthManager tokens');
        const token = await OAuthManager.getValidAccessToken();
        return `Bearer ${token}`;
      }

      Logger.debug('Falling back to Claude Code credentials');
      return await this.loadFromClaudeCodeCredentials();
    } catch (error) {
      throw new Error(`Failed to get auth token: ${error.message}`);
    }
  }

  async loadFromClaudeCodeCredentials() {
    try {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const credentialsData = fs.readFileSync(credentialsPath, 'utf8');
      const credentials = JSON.parse(credentialsData);
      const oauth = credentials.claudeAiOauth;

      if (oauth.expiresAt && Date.now() >= (oauth.expiresAt - 10000)) {
        Logger.info('Claude Code token expired/expiring, refreshing...');
        return await this.refreshTokenViaOAuth(credentials, credentialsPath);
      }
      return `Bearer ${oauth.accessToken}`;
    } catch (error) {
      throw new Error(`Failed to load Claude Code credentials: ${error.message}`);
    }
  }

  /**
   * Refresh token from Claude Code credentials file via OAuth endpoint.
   */
  async refreshTokenViaOAuth(credentials, credentialsPath) {
    if (ClaudeRequest.refreshPromise) return await ClaudeRequest.refreshPromise;

    ClaudeRequest.refreshPromise = (async () => {
      try {
        const refreshToken = credentials.claudeAiOauth?.refreshToken;
        const refreshData = {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
        };

        const response = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'console.anthropic.com',
            port: 443,
            path: '/v1/oauth/token',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            }
          };

          const req = https.request(options, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
              try {
                const parsed = JSON.parse(responseData);
                if (res.statusCode === 200) resolve(parsed);
                else reject(new Error(`OAuth refresh failed: ${parsed.error || responseData}`));
              } catch (e) {
                reject(new Error(`Invalid JSON response: ${responseData}`));
              }
            });
          });

          req.setTimeout(10000, () => { req.destroy(); reject(new Error('OAuth refresh timeout')); });
          req.on('error', reject);
          req.write(JSON.stringify(refreshData));
          req.end();
        });

        credentials.claudeAiOauth.accessToken = response.access_token;
        credentials.claudeAiOauth.refreshToken = response.refresh_token;
        credentials.claudeAiOauth.expiresAt = Date.now() + (response.expires_in * 1000);
        fs.writeFileSync(credentialsPath, JSON.stringify(credentials), 'utf8');

        Logger.info('Token refreshed successfully via Claude Code credentials');
        return `Bearer ${response.access_token}`;
      } finally {
        ClaudeRequest.refreshPromise = null;
      }
    })();

    return ClaudeRequest.refreshPromise;
  }

  getHeaders(token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': token,
      'anthropic-version': this.VERSION
    };
    if (this.BETA_HEADER) {
      headers['anthropic-beta'] = this.BETA_HEADER;
    }
    return headers;
  }

  /**
   * Prepend Claude Code system prompt and strip unsupported fields.
   */
  processRequestBody(body) {
    if (!body) return body;

    const systemPrompt = {
      type: 'text',
      text: 'You are Claude Code, Anthropic\'s official CLI for Claude.'
    };

    if (body.system) {
      if (Array.isArray(body.system)) {
        body.system.unshift(systemPrompt);
      } else {
        body.system = [systemPrompt, body.system];
      }
    } else {
      body.system = [systemPrompt];
    }

    body = this.stripTtlFromCacheControl(body);
    return body;
  }

  async makeRequest(body) {
    const token = await this.getAuthToken();
    const headers = this.getHeaders(token);
    const processedBody = this.processRequestBody(body);

    Logger.debug(`Proxying request (${JSON.stringify(processedBody).length} bytes)`);

    const urlParts = new URL(this.API_URL);
    const options = {
      hostname: urlParts.hostname,
      port: urlParts.port || 443,
      path: urlParts.pathname,
      method: 'POST',
      headers
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => { resolve(res); });
      req.on('error', (err) => { req.destroy(); reject(err); });
      req.write(JSON.stringify(processedBody));
      req.end();
    });
  }

  /**
   * Handle the full request lifecycle: proxy, auto-retry on 401, stream response.
   */
  async handleResponse(res, body) {
    try {
      const claudeResponse = await this.makeRequest(body);

      if (claudeResponse.statusCode === 401) {
        Logger.info('Got 401, attempting token refresh and retry');
        ClaudeRequest.cachedToken = null;

        try {
          const newToken = await this.loadOrRefreshToken();
          ClaudeRequest.cachedToken = newToken;
          const retryResponse = await this.makeRequest(body);
          res.statusCode = retryResponse.statusCode;
          Object.keys(retryResponse.headers).forEach(key => {
            res.setHeader(key, retryResponse.headers[key]);
          });
          this.streamResponse(res, retryResponse);
          return;
        } catch (error) {
          Logger.info('Token refresh failed, passing 401 to client');
        }
      }

      res.statusCode = claudeResponse.statusCode;
      Logger.debug(`Claude API status: ${claudeResponse.statusCode}`);
      Object.keys(claudeResponse.headers).forEach(key => {
        res.setHeader(key, claudeResponse.headers[key]);
      });
      this.streamResponse(res, claudeResponse);
    } catch (error) {
      Logger.error('Claude request error:', error.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * Stream or buffer response based on content type.
   */
  streamResponse(res, claudeResponse) {
    const extractClaudeText = (chunk) => {
      try {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.substring(6));
            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') return { text: data.delta.text };
              if (data.delta?.type === 'thinking_delta') return { thinking: data.delta.thinking };
            }
          }
        }
      } catch (e) { /* ignore parse errors in stream chunks */ }
      return null;
    };

    const contentType = claudeResponse.headers['content-type'] || '';

    if (contentType.includes('text/event-stream')) {
      // SSE streaming passthrough
      claudeResponse.on('error', (err) => {
        Logger.debug('Claude response stream error:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ error: 'Upstream response error' }));
      });

      res.on('close', () => {
        Logger.debug('Client disconnected, cleaning up streams');
        if (!claudeResponse.destroyed) claudeResponse.destroy();
      });

      if (Logger.getLogLevel() >= 3) {
        const debugStream = Logger.createDebugStream('Claude SSE', extractClaudeText);
        debugStream.on('error', (err) => {
          Logger.debug('Debug stream error:', err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          if (!res.destroyed) res.end(JSON.stringify({ error: 'Stream processing error' }));
        });
        claudeResponse.pipe(debugStream).pipe(res);
      } else {
        claudeResponse.pipe(res);
      }
    } else {
      // Non-streaming: buffer and forward
      res.removeHeader('content-encoding');
      let responseData = '';
      claudeResponse.on('data', chunk => { responseData += chunk; });
      claudeResponse.on('error', (err) => {
        Logger.error('Claude non-streaming response error:', err);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        if (!res.destroyed) res.end(JSON.stringify({ error: 'Upstream error', message: err.message }));
      });
      claudeResponse.on('end', () => {
        Logger.debug(`Non-streaming response (${claudeResponse.statusCode})`);
        try {
          const jsonData = JSON.parse(responseData);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(jsonData));
        } catch (e) {
          res.end(responseData);
        }
      });
    }
  }
}

module.exports = ClaudeRequest;
