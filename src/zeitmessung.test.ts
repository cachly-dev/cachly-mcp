/**
 * Zeitmessung (zeitmessung.ts): ohne CACHLY_ZEITMESSUNG kein Zeichen auf
 * stderr, mit der Variable eine Zeile je Messpunkt.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { zeitpunkt, zeitmessungAn } from './zeitmessung.js';

afterEach(() => {
  delete process.env.CACHLY_ZEITMESSUNG;
  vi.restoreAllMocks();
});

describe('zeitpunkt', () => {
  it('schreibt ohne CACHLY_ZEITMESSUNG nichts', () => {
    delete process.env.CACHLY_ZEITMESSUNG;
    const schreiben = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    zeitpunkt('probe');
    expect(schreiben).not.toHaveBeenCalled();
  });

  it('schreibt mit CACHLY_ZEITMESSUNG=1 eine Zeile mit Millisekunden', () => {
    process.env.CACHLY_ZEITMESSUNG = '1';
    const schreiben = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    zeitpunkt('probe');
    expect(schreiben).toHaveBeenCalledTimes(1);
    expect(String(schreiben.mock.calls[0][0])).toMatch(/^\[zeit\] \+\d+ ms probe\n$/);
  });

  it('zaehlt nur eindeutige Werte als an', () => {
    expect(zeitmessungAn({ CACHLY_ZEITMESSUNG: 'ja' })).toBe(true);
    expect(zeitmessungAn({ CACHLY_ZEITMESSUNG: '0' })).toBe(false);
    expect(zeitmessungAn({})).toBe(false);
  });
});
