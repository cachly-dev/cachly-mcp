import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function jwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    ) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Self-healing auth ─────────────────────────────────────────────────────────
// The silent-failure mode we guard against: a token that is missing, expired, or
// about to expire degrades the brain into "0 recalls" without the user ever being
// told why. Instead of failing silently (or only at the moment a network call
// finally 401s), we diagnose the credential up front and either heal it
// automatically (mint a fresh long-lived key while the current one is still valid)
// or surface a single, actionable instruction.

/** Long-lived API keys cannot expire silently; raw access tokens can. */
export const API_KEY_PREFIX = 'cky_';

export type AuthState = 'healthy' | 'no_jwt' | 'expired' | 'near_expiry' | 'long_lived';

export interface AuthDiagnosis {
  state: AuthState;
  /** Safe to make API calls right now? (healthy, near_expiry and long_lived all are.) */
  usable: boolean;
  /** ms until expiry, or null for tokens with no exp claim (long-lived keys). */
  expiresInMs: number | null;
  /** Human-facing message with the single fix, when action is needed. */
  message: string;
}

/** A long-lived API key (cky_live_… / cky_…) has no exp and never expires silently. */
export function isLongLivedApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

// Refresh a token this close to expiry (or already expired) the moment we touch it.
export const NEAR_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

const SETUP_URL = 'https://cachly.dev/setup-ai';

/**
 * Diagnose the current credential without making any network call. Pure +
 * deterministic (pass `now` in tests).
 */
export function diagnoseAuth(jwt: string, now: number = Date.now()): AuthDiagnosis {
  if (!jwt) {
    return {
      state: 'no_jwt',
      usable: false,
      expiresInMs: null,
      message: `No CACHLY_JWT set — the brain can't persist or recall anything (you'd silently get 0 recalls).\n\nGet your token at ${SETUP_URL} and add it to your MCP config, or just call any tool to start the one-time device-flow sign-in.`,
    };
  }

  const expMs = jwtExpiryMs(jwt);

  // No exp claim → long-lived API key. These are the healthy steady state.
  if (expMs === null) {
    return {
      state: isLongLivedApiKey(jwt) ? 'long_lived' : 'healthy',
      usable: true,
      expiresInMs: null,
      message: '',
    };
  }

  const remaining = expMs - now;
  if (remaining <= 0) {
    return {
      state: 'expired',
      usable: false,
      expiresInMs: remaining,
      message: `CACHLY_JWT expired at ${new Date(expMs).toISOString()} — recalls will silently return nothing until you re-authenticate.\n\nGet a fresh token at ${SETUP_URL}, or call any tool to re-run the device-flow sign-in.`,
    };
  }
  if (remaining <= NEAR_EXPIRY_MS) {
    const mins = Math.max(1, Math.round(remaining / 60_000));
    return {
      state: 'near_expiry',
      usable: true,
      expiresInMs: remaining,
      message: `CACHLY_JWT expires in ~${mins} min. cachly will refresh it automatically into a long-lived key while it's still valid.`,
    };
  }
  return { state: 'healthy', usable: true, expiresInMs: remaining, message: '' };
}

export type AuthHealAction =
  | 'none'      // credential is fine, nothing to do
  | 'refresh'   // still valid but should be exchanged for a fresh long-lived key now
  | 'reauth';   // unusable — needs the device flow / a new token

/**
 * Decide what self-healing step (if any) to take for a diagnosis. Pure so the
 * decision is unit-testable independently of the network-bound executor.
 */
export function planAuthHeal(d: AuthDiagnosis): AuthHealAction {
  switch (d.state) {
    case 'no_jwt':
    case 'expired':
      return 'reauth';
    case 'near_expiry':
      return 'refresh';
    case 'healthy':
    case 'long_lived':
      return 'none';
  }
}

export function checkJwt(jwt: string): void {
  const d = diagnoseAuth(jwt);
  if (!d.usable) {
    throw new McpError(ErrorCode.InvalidRequest, d.message);
  }
}

// ── M2M / headless auth (OAuth2 client_credentials) ──────────────────────────
// For machine-to-machine callers — CI runners, agent orchestrators, AI-to-AI
// pipelines — there is no human to complete a device flow. When CACHLY_CLIENT_ID
// and CACHLY_CLIENT_SECRET are present we run the standard OAuth2
// client_credentials grant against Keycloak and use the resulting access token
// exactly like a CACHLY_JWT. Fully non-interactive.

export const DEFAULT_AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  scope?: string;
  /** Override the Keycloak realm token base (self-host). */
  authBase?: string;
}

/** Read M2M client credentials from the environment, if both are present. */
export function readClientCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ClientCredentials | null {
  const clientId = env.CACHLY_CLIENT_ID;
  const clientSecret = env.CACHLY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    scope: env.CACHLY_CLIENT_SCOPE || 'openid',
    authBase: env.CACHLY_AUTH_URL || DEFAULT_AUTH_BASE,
  };
}

/** Build the application/x-www-form-urlencoded body for a client_credentials grant. */
export function buildClientCredentialsBody(c: ClientCredentials): string {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  if (c.scope) params.set('scope', c.scope);
  return params.toString();
}

/** Token endpoint URL for a given credentials/realm config. */
export function clientCredentialsTokenUrl(c: ClientCredentials): string {
  return `${c.authBase ?? DEFAULT_AUTH_BASE}/token`;
}

export function handleApiError(status: number, detail: string): never {
  if (status === 401) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Authentication failed (401): ${detail}\n\nYour CACHLY_JWT may be expired or invalid. Get a fresh token at ${SETUP_URL}`,
    );
  }
  if (status === 403) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Access denied (403): ${detail}\n\nCheck that your CACHLY_JWT belongs to an account with access to this resource.`,
    );
  }
  throw new McpError(ErrorCode.InternalError, `cachly API error ${status}: ${detail}`);
}
