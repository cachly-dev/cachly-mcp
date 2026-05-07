import { describe, it, expect } from 'vitest';
import { jwtExpiryMs } from '../auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJwt(payload: Record<string, unknown>): string {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  // Signature is intentionally fake — jwtExpiryMs only needs the payload.
  return `${header}.${body}.fakesig`;
}

const HOUR_MS = 60 * 60 * 1000;
const nowSec  = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// jwtExpiryMs
// ---------------------------------------------------------------------------

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

  it('returns null when the payload JSON has no exp field', () => {
    const token = makeJwt({ sub: 'user-123', iat: nowSec() });
    expect(jwtExpiryMs(token)).toBeNull();
  });

  it('returns null when exp is 0', () => {
    const token = makeJwt({ exp: 0 });
    expect(jwtExpiryMs(token)).toBeNull();
  });

  it('converts exp (seconds) to milliseconds correctly', () => {
    const expSec = nowSec() + 3600; // 1 hour from now
    const token  = makeJwt({ sub: 'user-1', exp: expSec });
    expect(jwtExpiryMs(token)).toBe(expSec * 1000);
  });

  it('returns a timestamp in the past for an already-expired token', () => {
    const expSec = nowSec() - 300; // expired 5 min ago
    const token  = makeJwt({ exp: expSec });
    const result = jwtExpiryMs(token);
    expect(result).not.toBeNull();
    expect(result!).toBeLessThan(Date.now());
  });

  it('returns a timestamp in the future for a valid token', () => {
    const expSec = nowSec() + 86400; // 24 h from now
    const token  = makeJwt({ exp: expSec });
    const result = jwtExpiryMs(token);
    expect(result).not.toBeNull();
    expect(result!).toBeGreaterThan(Date.now());
  });

  it('handles a token that expires in less than 60 minutes', () => {
    const minsLeft = 30;
    const expSec   = nowSec() + minsLeft * 60;
    const token    = makeJwt({ exp: expSec });
    const result   = jwtExpiryMs(token)!;

    const minsLeftCalculated = Math.floor((result - Date.now()) / 60_000);
    expect(minsLeftCalculated).toBeGreaterThanOrEqual(minsLeft - 1);
    expect(minsLeftCalculated).toBeLessThanOrEqual(minsLeft);
  });

  it('handles real-looking JWT structure with extra claims', () => {
    const expSec = nowSec() + HOUR_MS / 1000;
    const token  = makeJwt({
      sub: 'user-abc123',
      iat: nowSec(),
      exp: expSec,
      email: 'user@example.com',
      plan: 'free',
    });
    expect(jwtExpiryMs(token)).toBe(expSec * 1000);
  });

  it('handles a token whose payload has padding-free base64url encoding', () => {
    // Payloads with lengths that don't align to 4-byte boundaries rely on
    // base64url (no padding) — Buffer.from handles this natively.
    const expSec = nowSec() + 7200;
    const token  = makeJwt({ exp: expSec, x: 'a' }); // short payload
    expect(jwtExpiryMs(token)).toBe(expSec * 1000);
  });
});
