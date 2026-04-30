/**
 * OAuth 2.1 authorization server endpoints for the LinkedIn Ads MCP.
 *
 * Implements the subset required by the MCP authorization spec
 * (2025-06-18): RFC 9728 (Protected Resource Metadata), RFC 8414
 * (Authorization Server Metadata), RFC 7591 (Dynamic Client Registration),
 * RFC 8707 (Resource Indicators), and OAuth 2.1 PKCE.
 *
 * The MCP server proxies OAuth: Claude (the MCP client) talks OAuth to us;
 * we delegate the actual user identification to LinkedIn. LinkedIn credentials
 * never leave the server — Claude only sees opaque tokens we issue.
 *
 * Note: LinkedIn's OAuth 2.0 implementation does not accept PKCE on the
 * upstream side, so we use plain authorization-code flow with a `state`
 * parameter to LinkedIn. PKCE is enforced on the Claude → us side.
 */

import { Router, Request, Response } from 'express';
import * as crypto from 'crypto';
import {
  registerClient,
  getClient,
  savePendingAuthorization,
  consumePendingAuthorization,
  createAuthCode,
  consumeAuthCode,
  issueTokenPair,
  lookupAccessToken,
  consumeRefreshToken,
  saveLinkedInTokens,
  AccessTokenRecord,
} from './firestore-store.js';
import { LinkedInTokens } from '../lib/types.js';

const LINKEDIN_AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const LINKEDIN_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const LINKEDIN_USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

// Scopes we request from LinkedIn. Includes openid+email so we can identify
// the user via /v2/userinfo, plus the read+write Ads scopes the tools use.
const LINKEDIN_SCOPES = [
  'openid',
  'email',
  'r_ads',
  'r_ads_reporting',
  'rw_ads',
  'r_organization_social',
  'w_organization_social',
];

// Scopes we advertise to MCP clients (opaque to LinkedIn — protocol-level).
const ADVERTISED_SCOPES = ['linkedin.ads'];

function baseUrl(): string {
  const url = process.env.BASE_URL;
  if (!url) throw new Error('BASE_URL is not set');
  return url.replace(/\/$/, '');
}

function canonicalResource(): string {
  return `${baseUrl()}/mcp`;
}

function linkedinRedirectUri(): string {
  return process.env.LINKEDIN_REDIRECT_URI || `${baseUrl()}/oauth/callback`;
}

function linkedinClientId(): string {
  const v = process.env.LINKEDIN_CLIENT_ID;
  if (!v) throw new Error('LINKEDIN_CLIENT_ID is not set');
  return v;
}

function linkedinClientSecret(): string {
  const v = process.env.LINKEDIN_CLIENT_SECRET;
  if (!v) throw new Error('LINKEDIN_CLIENT_SECRET is not set');
  return v;
}

function allowedEmails(): string[] {
  const raw = (process.env.ALLOWED_EMAILS || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== 'S256') return false;
  const digest = crypto.createHash('sha256').update(verifier, 'ascii').digest();
  const expected = digest.toString('base64url');
  if (expected.length !== challenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(challenge));
}

function oauthError(res: Response, error: string, description = '', status = 400): void {
  res.status(status).json(description ? { error, error_description: description } : { error });
}

export const oauthRouter = Router();

// ---------- Discovery ----------

oauthRouter.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
  res.json({
    resource: canonicalResource(),
    authorization_servers: [baseUrl()],
    scopes_supported: ADVERTISED_SCOPES,
    bearer_methods_supported: ['header'],
  });
});

oauthRouter.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  const base = baseUrl();
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ADVERTISED_SCOPES,
  });
});

// ---------- Dynamic Client Registration ----------

oauthRouter.post('/oauth/register', async (req: Request, res: Response) => {
  const body = req.body || {};
  const redirectUris = body.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError(res, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array');
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string') {
      return oauthError(res, 'invalid_redirect_uri', 'redirect_uris must be strings');
    }
    if (!(uri.startsWith('https://') || uri.startsWith('http://localhost') || uri.startsWith('http://127.0.0.1'))) {
      return oauthError(res, 'invalid_redirect_uri', `redirect_uri must be https or localhost: ${uri}`);
    }
  }
  const clientName = body.client_name || 'Unnamed MCP Client';
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k !== 'redirect_uris' && k !== 'client_name') metadata[k] = v;
  }
  const record = await registerClient(redirectUris, clientName, metadata);
  res.status(201).json(record);
});

// ---------- /oauth/authorize ----------

oauthRouter.get('/oauth/authorize', async (req: Request, res: Response) => {
  const qp = req.query;
  const responseType = String(qp.response_type || '');
  const clientId = String(qp.client_id || '');
  const redirectUri = String(qp.redirect_uri || '');
  const codeChallenge = String(qp.code_challenge || '');
  const codeChallengeMethod = String(qp.code_challenge_method || '');
  const clientState = qp.state ? String(qp.state) : '';
  const scope = qp.scope ? String(qp.scope) : ADVERTISED_SCOPES.join(' ');
  const requestedResource = qp.resource ? String(qp.resource) : '';

  if (responseType !== 'code') {
    return oauthError(res, 'unsupported_response_type', "Only 'code' is supported");
  }
  if (!clientId) return oauthError(res, 'invalid_request', 'client_id is required');

  const client = await getClient(clientId);
  if (!client) return oauthError(res, 'invalid_client', 'Unknown client_id', 401);
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return oauthError(res, 'invalid_request', 'redirect_uri not registered');
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return oauthError(res, 'invalid_request', 'PKCE with S256 is required');
  }

  const canonical = canonicalResource();
  if (requestedResource && requestedResource.replace(/\/$/, '') !== canonical.replace(/\/$/, '')) {
    return oauthError(res, 'invalid_target', `resource must be ${canonical}`);
  }

  const ourState = crypto.randomBytes(32).toString('base64url');
  await savePendingAuthorization(ourState, {
    client_id: clientId,
    redirect_uri: redirectUri,
    client_state: clientState,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    resource: canonical,
    scope,
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: linkedinClientId(),
    redirect_uri: linkedinRedirectUri(),
    state: ourState,
    scope: LINKEDIN_SCOPES.join(' '),
  });
  res.redirect(`${LINKEDIN_AUTHORIZE_URL}?${params.toString()}`);
});

// ---------- /oauth/callback (LinkedIn redirects here) ----------

oauthRouter.get('/oauth/callback', async (req: Request, res: Response) => {
  const qp = req.query;
  const error = qp.error ? String(qp.error) : '';
  const code = qp.code ? String(qp.code) : '';
  const state = qp.state ? String(qp.state) : '';

  if (error) {
    return res.status(400).send(`<h2>LinkedIn login cancelled</h2><p>${escapeHtml(error)}</p>`);
  }
  if (!state || !code) {
    return res.status(400).send('<h2>Missing state or code</h2>');
  }

  const pending = await consumePendingAuthorization(state);
  if (!pending) {
    return res.status(400).send(
      '<h2>This authorization request has expired or already been used.</h2>' +
      '<p>Please retry the connect flow from your MCP client.</p>'
    );
  }

  // Exchange LinkedIn auth code for tokens
  let liTokens: LinkedInTokens;
  try {
    const resp = await fetch(LINKEDIN_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: linkedinClientId(),
        client_secret: linkedinClientSecret(),
        redirect_uri: linkedinRedirectUri(),
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).send(
        `<h2>LinkedIn token exchange failed</h2><pre>${escapeHtml(text)}</pre>`
      );
    }
    const fresh = await resp.json() as Omit<LinkedInTokens, 'expires_at'>;
    liTokens = {
      ...fresh,
      expires_at: Math.floor(Date.now() / 1000) + fresh.expires_in,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return res.status(502).send(`<h2>LinkedIn token exchange failed</h2><p>${escapeHtml(msg)}</p>`);
  }

  // Identify the user via LinkedIn's userinfo endpoint
  let email = '';
  try {
    const userResp = await fetch(LINKEDIN_USERINFO_URL, {
      headers: { Authorization: `Bearer ${liTokens.access_token}` },
    });
    if (userResp.ok) {
      const info = await userResp.json() as { email?: string; sub?: string };
      email = (info.email || info.sub || '').toLowerCase();
    }
  } catch {
    // fall through to empty email check
  }
  if (!email) {
    return res.status(502).send(
      '<h2>Could not read your LinkedIn profile.</h2>' +
      '<p>The token request succeeded, but we were unable to fetch your email. Make sure the OAuth app has the openid and email scopes enabled.</p>'
    );
  }

  // Optional email allow-list (off by default; LinkedIn auth alone is the gate)
  const allow = allowedEmails();
  if (allow.length > 0 && !allow.includes(email)) {
    return res.status(403).send(
      `<h2>Access denied</h2><p>The LinkedIn email <strong>${escapeHtml(email)}</strong> is not on the allow-list.</p>`
    );
  }

  await saveLinkedInTokens(email, liTokens);

  const ourCode = await createAuthCode({
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: pending.code_challenge,
    code_challenge_method: pending.code_challenge_method,
    resource: pending.resource,
    scope: pending.scope,
    user_email: email,
  });

  const params = new URLSearchParams({ code: ourCode });
  if (pending.client_state) params.set('state', pending.client_state);
  const sep = pending.redirect_uri.includes('?') ? '&' : '?';
  res.redirect(`${pending.redirect_uri}${sep}${params.toString()}`);
});

// ---------- /oauth/token ----------

oauthRouter.post('/oauth/token', async (req: Request, res: Response) => {
  const body = req.body || {};
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    return tokenAuthorizationCode(req, res);
  }
  if (grantType === 'refresh_token') {
    return tokenRefresh(req, res);
  }
  return oauthError(res, 'unsupported_grant_type', `Unsupported grant_type: ${grantType}`);
});

async function tokenAuthorizationCode(req: Request, res: Response): Promise<void> {
  const body = req.body || {};
  const code = body.code;
  const clientId = body.client_id;
  const redirectUri = body.redirect_uri;
  const codeVerifier = body.code_verifier;
  const requestedResource = body.resource;

  if (!code || !clientId || !redirectUri || !codeVerifier) {
    return oauthError(res, 'invalid_request', 'Missing required fields');
  }

  const record = await consumeAuthCode(code);
  if (!record) return oauthError(res, 'invalid_grant', 'Authorization code invalid or expired');
  if (record.client_id !== clientId) return oauthError(res, 'invalid_grant', 'client_id does not match');
  if (record.redirect_uri !== redirectUri) return oauthError(res, 'invalid_grant', 'redirect_uri does not match');
  if (!verifyPkce(codeVerifier, record.code_challenge, record.code_challenge_method)) {
    return oauthError(res, 'invalid_grant', 'PKCE verification failed');
  }
  const canonical = canonicalResource();
  if (requestedResource && String(requestedResource).replace(/\/$/, '') !== canonical.replace(/\/$/, '')) {
    return oauthError(res, 'invalid_target', `resource must be ${canonical}`);
  }

  const pair = await issueTokenPair({
    client_id: clientId,
    user_email: record.user_email,
    resource: record.resource,
    scope: record.scope,
  });
  res.json(pair);
}

async function tokenRefresh(req: Request, res: Response): Promise<void> {
  const body = req.body || {};
  const refreshToken = body.refresh_token;
  const clientId = body.client_id;
  if (!refreshToken || !clientId) return oauthError(res, 'invalid_request', 'Missing required fields');

  const record = await consumeRefreshToken(refreshToken);
  if (!record) return oauthError(res, 'invalid_grant', 'Refresh token invalid or expired');
  if (record.client_id !== clientId) return oauthError(res, 'invalid_grant', 'client_id does not match');

  const pair = await issueTokenPair({
    client_id: clientId,
    user_email: record.user_email,
    resource: record.resource,
    scope: record.scope,
  });
  res.json(pair);
}

// ---------- Bearer resolution (used by /mcp middleware) ----------

export async function resolveBearer(accessToken: string): Promise<AccessTokenRecord | null> {
  const record = await lookupAccessToken(accessToken);
  if (!record) return null;
  if ((record.resource || '').replace(/\/$/, '') !== canonicalResource().replace(/\/$/, '')) {
    return null;
  }
  return record;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
