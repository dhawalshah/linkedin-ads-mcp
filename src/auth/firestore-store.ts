/**
 * Firestore-backed storage for the embedded OAuth 2.1 authorization server
 * and per-user LinkedIn credentials.
 *
 * Collections (shared with the rest of the team-mcp services where applicable):
 *   oauth_clients/{client_id}        — DCR client registrations
 *   oauth_pending/{state}            — pending /oauth/authorize → LinkedIn round-trip
 *   oauth_codes/{code}               — issued authorization codes (single-use)
 *   oauth_tokens/{access_token}      — issued bearer access tokens (1h TTL)
 *   oauth_refresh/{refresh_token}    — issued refresh tokens (30d TTL)
 *   user_tokens_linkedin_ads/{email} — per-user LinkedIn credentials
 *
 * The first five collections are shared with other team-mcp services; the
 * tokens are random opaque strings so collisions are impossible. The last
 * collection is LinkedIn-specific.
 */

import { Firestore, FieldValue, Timestamp } from '@google-cloud/firestore';
import * as crypto from 'crypto';
import { LinkedInTokens, TokenProvider } from '../lib/types.js';

const PENDING_TTL_SECONDS = 10 * 60;
const CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

let _db: Firestore | null = null;
function db(): Firestore {
  if (!_db) {
    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) throw new Error('GCP_PROJECT_ID is not set');
    _db = new Firestore({ projectId });
  }
  return _db;
}

function now(): Date {
  return new Date();
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function isExpired(expiresAt: Date | Timestamp | undefined | null): boolean {
  if (!expiresAt) return false;
  const t = expiresAt instanceof Timestamp ? expiresAt.toDate() : expiresAt;
  return t.getTime() < Date.now();
}

function newToken(prefix: string, nbytes = 32): string {
  return `${prefix}_${crypto.randomBytes(nbytes).toString('base64url')}`;
}

// ---------- DCR clients ----------

export interface OAuthClient {
  client_id: string;
  redirect_uris: string[];
  client_name: string;
  metadata: Record<string, unknown>;
}

export async function registerClient(
  redirectUris: string[],
  clientName: string,
  metadata: Record<string, unknown>
): Promise<{ client_id: string; client_id_issued_at: number; redirect_uris: string[]; client_name: string; token_endpoint_auth_method: string; grant_types: string[]; response_types: string[] } & Record<string, unknown>> {
  const clientId = newToken('mcp_client', 16);
  await db().collection('oauth_clients').doc(clientId).set({
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: clientName,
    metadata,
    created_at: FieldValue.serverTimestamp(),
  });
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: redirectUris,
    client_name: clientName,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...metadata,
  };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const snap = await db().collection('oauth_clients').doc(clientId).get();
  if (!snap.exists) return null;
  return snap.data() as OAuthClient;
}

// ---------- Pending authorizations ----------

export interface PendingAuthorization {
  client_id: string;
  redirect_uri: string;
  client_state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  scope: string;
}

export async function savePendingAuthorization(
  state: string,
  data: PendingAuthorization
): Promise<void> {
  await db().collection('oauth_pending').doc(state).set({
    ...data,
    expires_at: expiresIn(PENDING_TTL_SECONDS),
  });
}

export async function consumePendingAuthorization(state: string): Promise<PendingAuthorization | null> {
  const ref = db().collection('oauth_pending').doc(state);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as PendingAuthorization & { expires_at?: Timestamp };
  await ref.delete();
  if (isExpired(data.expires_at)) return null;
  return data;
}

// ---------- Authorization codes ----------

export interface AuthCodeRecord {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  scope: string;
  user_email: string;
}

export async function createAuthCode(record: AuthCodeRecord): Promise<string> {
  const code = newToken('mcp_ac');
  await db().collection('oauth_codes').doc(code).set({
    ...record,
    expires_at: expiresIn(CODE_TTL_SECONDS),
  });
  return code;
}

export async function consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
  const ref = db().collection('oauth_codes').doc(code);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as AuthCodeRecord & { expires_at?: Timestamp };
  await ref.delete();
  if (isExpired(data.expires_at)) return null;
  return data;
}

// ---------- Access + refresh tokens (issued by us) ----------

export interface AccessTokenRecord {
  client_id: string;
  user_email: string;
  resource: string;
  scope: string;
}

export interface IssuedTokenPair {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export async function issueTokenPair(record: AccessTokenRecord): Promise<IssuedTokenPair> {
  const access = newToken('mcp_at');
  const refresh = newToken('mcp_rt');
  await db().collection('oauth_tokens').doc(access).set({
    ...record,
    expires_at: expiresIn(ACCESS_TTL_SECONDS),
  });
  await db().collection('oauth_refresh').doc(refresh).set({
    ...record,
    expires_at: expiresIn(REFRESH_TTL_SECONDS),
  });
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh,
    scope: record.scope,
  };
}

export async function lookupAccessToken(accessToken: string): Promise<AccessTokenRecord | null> {
  const snap = await db().collection('oauth_tokens').doc(accessToken).get();
  if (!snap.exists) return null;
  const data = snap.data() as AccessTokenRecord & { expires_at?: Timestamp };
  if (isExpired(data.expires_at)) return null;
  return data;
}

export async function consumeRefreshToken(refreshToken: string): Promise<AccessTokenRecord | null> {
  // OAuth 2.1 §4.3.1 — refresh tokens are single use
  const ref = db().collection('oauth_refresh').doc(refreshToken);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as AccessTokenRecord & { expires_at?: Timestamp };
  await ref.delete();
  if (isExpired(data.expires_at)) return null;
  return data;
}

// ---------- Per-user LinkedIn credentials ----------

const LINKEDIN_TOKENS_COLLECTION = 'user_tokens_linkedin_ads';

export async function saveLinkedInTokens(email: string, tokens: LinkedInTokens): Promise<void> {
  await db().collection(LINKEDIN_TOKENS_COLLECTION).doc(email).set({
    tokens,
    updated_at: FieldValue.serverTimestamp(),
  });
}

export async function loadLinkedInTokens(email: string): Promise<LinkedInTokens | null> {
  const snap = await db().collection(LINKEDIN_TOKENS_COLLECTION).doc(email).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return (data?.tokens as LinkedInTokens) || null;
}

/**
 * Returns a valid LinkedIn access token for the user, refreshing if necessary.
 * Returns null if no tokens stored or refresh fails.
 */
export async function getValidLinkedInAccessToken(email: string): Promise<string | null> {
  const tokens = await loadLinkedInTokens(email);
  if (!tokens) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (tokens.expires_at > nowSec + 300) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) return null;

  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const response = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok) return null;
    const fresh = await response.json() as Omit<LinkedInTokens, 'expires_at'>;
    const merged: LinkedInTokens = {
      ...fresh,
      // LinkedIn may not return a new refresh_token; keep the old one if absent
      refresh_token: fresh.refresh_token || tokens.refresh_token,
      refresh_token_expires_in: fresh.refresh_token_expires_in ?? tokens.refresh_token_expires_in,
      expires_at: Math.floor(Date.now() / 1000) + fresh.expires_in,
    };
    await saveLinkedInTokens(email, merged);
    return merged.access_token;
  } catch {
    return null;
  }
}

/**
 * A TokenProvider for a specific user; can be passed to LinkedInApiClient.
 * Refreshes on demand if the cached access token is near expiry.
 */
export class UserScopedTokenProvider implements TokenProvider {
  constructor(private email: string) {}

  async getAccessToken(): Promise<string | null> {
    return getValidLinkedInAccessToken(this.email);
  }
}
