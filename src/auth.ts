/**
 * Decode the `exp` claim from a JWT without a network round-trip.
 *
 * Returns the expiry time in **milliseconds** (suitable for comparison with
 * `Date.now()`), or `null` when the token is malformed, has no `exp` claim,
 * or the claim is falsy (e.g. 0).
 */
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
