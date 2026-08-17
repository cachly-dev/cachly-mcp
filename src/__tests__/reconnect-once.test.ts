import { describe, it, expect } from 'vitest';
import { reconnectOnce } from '../index.js';

/**
 * The regression (2026-08-16, one working session): with `retryStrategy: () =>
 * null` the FIRST brain call after every idle stretch died with "Connection is
 * closed" — five times in one day — because the pooled socket had gone
 * half-open and reconnects were disabled. The retyped second call always
 * worked, which is exactly what "one reconnect would have healed it" looks
 * like from the outside.
 */
describe('reconnectOnce', () => {
  it('allows exactly one reconnect attempt, quickly', () => {
    expect(reconnectOnce(1)).toBe(200);
  });

  it('fails fast from the second attempt on — no reconnect loops in MCP context', () => {
    expect(reconnectOnce(2)).toBeNull();
    expect(reconnectOnce(3)).toBeNull();
    expect(reconnectOnce(100)).toBeNull();
  });

  it('never returns a long delay that would hang a tool call', () => {
    const d = reconnectOnce(1);
    expect(d).not.toBeNull();
    expect(d!).toBeLessThanOrEqual(1000);
  });
});
