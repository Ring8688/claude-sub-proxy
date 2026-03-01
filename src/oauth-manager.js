const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const Logger = require('./logger');

const OAUTH_CONFIG = {
  client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorize_url: 'https://claude.ai/oauth/authorize',
  token_url: 'https://console.anthropic.com/v1/oauth/token',
  redirect_uri: 'https://console.anthropic.com/oauth/code/callback',
  scope: 'org:create_api_key user:profile user:inference'
};

class OAuthManager {
  constructor() {
    this.tokenPath = path.join(
      process.env.HOME || process.env.USERPROFILE,
      '.claude-sub-proxy',
      'tokens.json'
    );
    this.cachedToken = null;
    this.refreshPromise = null;
  }

  /**
   * Generate PKCE code verifier, challenge, and state for OAuth flow.
   */
  generatePKCE() {
    const code_verifier = crypto.randomBytes(32).toString('base64url');
    const code_challenge = crypto
      .createHash('sha256')
      .update(code_verifier)
      .digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    return { code_verifier, code_challenge, state };
  }

  /**
   * Build authorization URL for user to visit.
   */
  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: OAUTH_CONFIG.client_id,
      response_type: 'code',
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: 'S256',
      state: pkce.state
    });
    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access and refresh tokens.
   */
  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = JSON.stringify({
      grant_type: 'authorization_code',
      code,
      state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    });

    try {
      const response = await this._makeTokenRequest(payload);
      Logger.info('Successfully exchanged authorization code for tokens');
      return response;
    } catch (error) {
      Logger.error('Failed to exchange code for tokens', error);
      throw error;
    }
  }

  /**
   * Refresh the access token using the refresh token.
   * Uses a singleton promise to prevent race conditions.
   */
  async refreshAccessToken() {
    if (this.refreshPromise) {
      Logger.debug('Token refresh already in progress, waiting...');
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const tokens = this.loadTokens();
        if (!tokens || !tokens.refresh_token) {
          throw new Error('No refresh token available');
        }

        const payload = JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token,
          client_id: OAUTH_CONFIG.client_id
        });

        const response = await this._makeTokenRequest(payload);
        Logger.info('Successfully refreshed access token');

        const newTokens = {
          access_token: response.access_token,
          refresh_token: response.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + (response.expires_in * 1000)
        };
        this.saveTokens(newTokens);
        this.cachedToken = newTokens.access_token;

        return response;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Make an HTTPS POST to the OAuth token endpoint.
   */
  _makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_CONFIG.token_url);
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse token response: ${error.message}`));
            }
          } else {
            reject(new Error(`Token request failed with status ${res.statusCode}: ${data}`));
          }
        });
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Token request timeout'));
      });

      req.on('error', (error) => { reject(error); });
      req.write(payload);
      req.end();
    });
  }

  loadTokens() {
    try {
      if (!fs.existsSync(this.tokenPath)) return null;
      const data = fs.readFileSync(this.tokenPath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      Logger.error('Failed to load tokens from file', error);
      return null;
    }
  }

  saveTokens(tokens) {
    try {
      const dir = path.dirname(this.tokenPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
      if (process.platform !== 'win32') {
        fs.chmodSync(this.tokenPath, 0o600);
      }
      Logger.info('Tokens saved successfully');
    } catch (error) {
      Logger.error('Failed to save tokens to file', error);
      throw error;
    }
  }

  /**
   * Get a valid access token, auto-refreshing if within 60s of expiry.
   */
  async getValidAccessToken() {
    if (this.cachedToken) {
      const tokens = this.loadTokens();
      if (tokens && tokens.expires_at > Date.now() + 60000) {
        return this.cachedToken;
      }
    }

    const tokens = this.loadTokens();
    if (!tokens) {
      throw new Error('No authentication tokens found. Please authenticate first.');
    }

    if (tokens.expires_at <= Date.now() + 60000) {
      Logger.info('Access token expired or expiring soon, refreshing...');
      await this.refreshAccessToken();
      const newTokens = this.loadTokens();
      this.cachedToken = newTokens.access_token;
      return this.cachedToken;
    }

    this.cachedToken = tokens.access_token;
    return tokens.access_token;
  }

  isAuthenticated() {
    const tokens = this.loadTokens();
    return !!(tokens && tokens.access_token && tokens.refresh_token);
  }

  getTokenExpiration() {
    const tokens = this.loadTokens();
    if (!tokens || !tokens.expires_at) return null;
    return new Date(tokens.expires_at);
  }

  logout() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
        Logger.info('Tokens deleted successfully');
      }
      this.cachedToken = null;
    } catch (error) {
      Logger.error('Failed to delete tokens', error);
      throw error;
    }
  }
}

module.exports = new OAuthManager();
