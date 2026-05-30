import { describe, it, expect } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { jwtExpiryMs, checkJwt, handleApiError,
         diagnoseAuth, planAuthHeal, isLongLivedApiKey, NEAR_EXPIRY_MS,
         readClientCredentialsFromEnv, buildClientCredentialsBody,
         clientCredentialsTokenUrl, DEFAULT_AUTH_BASE } from '../auth.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

describe('jwtExpiryMs', () => {
  it('returns null for an empty string', () => {
    expect(jwtExpiryMs('')).toBeNull();
  });

  it('returns null for a plain (non-JWT) string', () => {
    expect(jwtExpiryMs('not-a-token')).toBeNull();
  });

  it('returns null when the JWT has only two parts', () => {
    expect(jwtExpiryMs('header.payload')).toBeNull();
  });

  it('returns null when the JWT has four parts', () => {
    expect(jwtExpiryMs('a.b.c.d')).toBeNull();
  });

  it('returns null when the payload base64 is invalid', () => {
    expect(jwtExpiryMs('header.!!!.sig')).toBeNull();
  });

  it('returns null when the payload has no exp field', () => {
    expect(jwtExpiryMs(makeJwt({ sub: 'user-123', iat: nowSec() }))).toBeNull();
  });

  it('returns null when exp is 0', () => {
    expect(jwtExpiryMs(makeJwt({ exp: 0 }))).toBeNull();
  });

  it('converts exp (seconds) to milliseconds', () => {
    const expSec = nowSec() + 3600;
    expect(jwtExpiryMs(makeJwt({ exp: expSec }))).toBe(expSec * 1000);
  });

  it('returns a past timestamp for an expired token', () => {
    expect(jwtExpiryMs(makeJwt({ exp: nowSec() - 300 }))).toBeLessThan(Date.now());
  });

  it('returns a future timestamp for a valid token', () => {
    expect(jwtExpiryMs(makeJwt({ exp: nowSec() + 86400 }))).toBeGreaterThan(Date.now());
  });

  it('handles a token expiring in less than 60 minutes', () => {
    const expSec = nowSec() + 30 * 60;
    const result = jwtExpiryMs(makeJwt({ exp: expSec }))!;
    const minsLeft = Math.floor((result - Date.now()) / 60_000);
    expect(minsLeft).toBeGreaterThanOrEqual(29);
    expect(minsLeft).toBeLessThanOrEqual(30);
  });

  it('ignores extra claims', () => {
    const expSec = nowSec() + 3600;
    expect(jwtExpiryMs(makeJwt({ sub: 'u', iat: nowSec(), exp: expSec, plan: 'free' }))).toBe(expSec * 1000);
  });

  it('handles padding-free base64url payloads', () => {
    // base64url (no =) — Buffer.from handles this natively
    const expSec = nowSec() + 7200;
    expect(jwtExpiryMs(makeJwt({ exp: expSec, x: 'a' }))).toBe(expSec * 1000);
  });
});

describe('checkJwt', () => {
  it('throws InvalidRequest when jwt is empty', () => {
    expect(() => checkJwt('')).toThrowError(
      expect.objectContaining({ code: ErrorCode.InvalidRequest, message: expect.stringContaining('No CACHLY_JWT set') }),
    );
  });

  it('throws with setup URL when jwt is missing', () => {
    expect(() => checkJwt('')).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('cachly.dev/setup-ai') }),
    );
  });

  it('throws InvalidRequest with expiry timestamp for an expired token', () => {
    const expSec = nowSec() - 60;
    const token  = makeJwt({ exp: expSec });
    expect(() => checkJwt(token)).toThrowError(
      expect.objectContaining({
        code: ErrorCode.InvalidRequest,
        message: expect.stringContaining('expired at'),
      }),
    );
  });

  it('does not throw for a valid non-expired token', () => {
    expect(() => checkJwt(makeJwt({ exp: nowSec() + 3600 }))).not.toThrow();
  });

  it('does not throw for a token with no exp claim', () => {
    expect(() => checkJwt(makeJwt({ sub: 'user' }))).not.toThrow();
  });
});

describe('handleApiError', () => {
  it('throws InvalidRequest for 401 with the detail message', () => {
    expect(() => handleApiError(401, 'token expired')).toThrowError(
      expect.objectContaining({
        code: ErrorCode.InvalidRequest,
        message: expect.stringContaining('Authentication failed (401): token expired'),
      }),
    );
  });

  it('throws InvalidRequest for 403 with the detail message', () => {
    expect(() => handleApiError(403, 'plan limit reached')).toThrowError(
      expect.objectContaining({
        code: ErrorCode.InvalidRequest,
        message: expect.stringContaining('Access denied (403): plan limit reached'),
      }),
    );
  });

  it('throws InternalError for other status codes', () => {
    expect(() => handleApiError(500, 'server crash')).toThrowError(
      expect.objectContaining({
        code: ErrorCode.InternalError,
        message: expect.stringContaining('cachly API error 500: server crash'),
      }),
    );
  });

  it('includes the cachly.dev/setup-ai link for 401 errors', () => {
    expect(() => handleApiError(401, 'Unauthorized')).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('cachly.dev/setup-ai') }),
    );
  });

  it('includes account access hint for 403 errors', () => {
    expect(() => handleApiError(403, 'Forbidden')).toThrowError(
      expect.objectContaining({ message: expect.stringContaining('access to this resource') }),
    );
  });
});

describe('isLongLivedApiKey', () => {
  it('recognizes cky_ prefixed keys', () => {
    expect(isLongLivedApiKey('cky_live_abc123')).toBe(true);
    expect(isLongLivedApiKey('cky_test_xyz')).toBe(true);
  });
  it('rejects raw JWTs and empty strings', () => {
    expect(isLongLivedApiKey('')).toBe(false);
    expect(isLongLivedApiKey(makeJwt({ exp: nowSec() + 3600 }))).toBe(false);
  });
});

describe('diagnoseAuth', () => {
  it('reports no_jwt (unusable) for an empty token', () => {
    const d = diagnoseAuth('');
    expect(d.state).toBe('no_jwt');
    expect(d.usable).toBe(false);
    expect(d.message).toContain('No CACHLY_JWT');
  });

  it('reports long_lived (usable) for a cky_ key with no exp', () => {
    const d = diagnoseAuth('cky_live_deadbeef');
    expect(d.state).toBe('long_lived');
    expect(d.usable).toBe(true);
    expect(d.expiresInMs).toBeNull();
  });

  it('reports healthy for a JWT with no exp claim', () => {
    const d = diagnoseAuth(makeJwt({ sub: 'u' }));
    expect(d.state).toBe('healthy');
    expect(d.usable).toBe(true);
  });

  it('reports expired (unusable) for a past exp', () => {
    const exp = nowSec() - 60;
    const d = diagnoseAuth(makeJwt({ exp }));
    expect(d.state).toBe('expired');
    expect(d.usable).toBe(false);
    expect(d.expiresInMs).toBeLessThanOrEqual(0);
    expect(d.message).toContain('expired at');
  });

  it('reports near_expiry (still usable) within the threshold', () => {
    const exp = Math.floor((Date.now() + NEAR_EXPIRY_MS - 60_000) / 1000);
    const d = diagnoseAuth(makeJwt({ exp }));
    expect(d.state).toBe('near_expiry');
    expect(d.usable).toBe(true);
    expect(d.message).toContain('refresh');
  });

  it('reports healthy for a token well beyond the near-expiry threshold', () => {
    const exp = nowSec() + 24 * 3600;
    const d = diagnoseAuth(makeJwt({ exp }));
    expect(d.state).toBe('healthy');
    expect(d.usable).toBe(true);
    expect(d.expiresInMs).toBeGreaterThan(NEAR_EXPIRY_MS);
  });

  it('is deterministic with an injected now', () => {
    const now = 1_000_000_000_000;
    const exp = Math.floor((now + 5 * 60_000) / 1000); // 5 min after the injected now
    const d = diagnoseAuth(makeJwt({ exp }), now);
    expect(d.state).toBe('near_expiry');
  });
});

describe('planAuthHeal', () => {
  it('plans reauth for missing or expired credentials', () => {
    expect(planAuthHeal(diagnoseAuth(''))).toBe('reauth');
    expect(planAuthHeal(diagnoseAuth(makeJwt({ exp: nowSec() - 10 })))).toBe('reauth');
  });
  it('plans refresh for a near-expiry token', () => {
    const exp = Math.floor((Date.now() + NEAR_EXPIRY_MS - 60_000) / 1000);
    expect(planAuthHeal(diagnoseAuth(makeJwt({ exp })))).toBe('refresh');
  });
  it('plans no action for healthy / long-lived credentials', () => {
    expect(planAuthHeal(diagnoseAuth(makeJwt({ exp: nowSec() + 86400 })))).toBe('none');
    expect(planAuthHeal(diagnoseAuth('cky_live_abc'))).toBe('none');
  });
});

describe('M2M client_credentials auth', () => {
  it('returns null when either credential is missing', () => {
    expect(readClientCredentialsFromEnv({})).toBeNull();
    expect(readClientCredentialsFromEnv({ CACHLY_CLIENT_ID: 'x' } as NodeJS.ProcessEnv)).toBeNull();
    expect(readClientCredentialsFromEnv({ CACHLY_CLIENT_SECRET: 'y' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('reads both credentials with sensible defaults', () => {
    const c = readClientCredentialsFromEnv({ CACHLY_CLIENT_ID: 'svc', CACHLY_CLIENT_SECRET: 'shh' } as NodeJS.ProcessEnv);
    expect(c).toEqual({ clientId: 'svc', clientSecret: 'shh', scope: 'openid', authBase: DEFAULT_AUTH_BASE });
  });

  it('honors scope and self-host auth base overrides', () => {
    const c = readClientCredentialsFromEnv({
      CACHLY_CLIENT_ID: 'svc', CACHLY_CLIENT_SECRET: 'shh',
      CACHLY_CLIENT_SCOPE: 'openid profile', CACHLY_AUTH_URL: 'https://kc.local/realms/r/protocol/openid-connect',
    } as NodeJS.ProcessEnv);
    expect(c?.scope).toBe('openid profile');
    expect(c?.authBase).toBe('https://kc.local/realms/r/protocol/openid-connect');
  });

  it('builds a valid client_credentials form body', () => {
    const body = buildClientCredentialsBody({ clientId: 'svc', clientSecret: 's/h h', scope: 'openid' });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('client_credentials');
    expect(p.get('client_id')).toBe('svc');
    expect(p.get('client_secret')).toBe('s/h h'); // properly url-encoded round-trip
    expect(p.get('scope')).toBe('openid');
  });

  it('omits scope from the body when not provided', () => {
    const body = buildClientCredentialsBody({ clientId: 'svc', clientSecret: 'shh' });
    expect(new URLSearchParams(body).has('scope')).toBe(false);
  });

  it('derives the token endpoint from the realm base', () => {
    expect(clientCredentialsTokenUrl({ clientId: 'a', clientSecret: 'b' })).toBe(`${DEFAULT_AUTH_BASE}/token`);
    expect(clientCredentialsTokenUrl({ clientId: 'a', clientSecret: 'b', authBase: 'https://kc.local/x' })).toBe('https://kc.local/x/token');
  });
});
