import { describe, it, expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { jwtExpiryMs, checkJwt, handleApiError } from '../auth.js';

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
      expect.objectContaining({ code: ErrorCode.InvalidRequest, message: expect.stringContaining('CACHLY_JWT env var not set') }),
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
