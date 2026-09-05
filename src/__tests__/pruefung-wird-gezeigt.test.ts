/**
 * Eine gefallene Prüfung muss man SEHEN.
 *
 * `lesson_verified(haelt=false)` schreibt `pruefung_gefallen_am` und
 * `pruefung_befund`. Beim ersten Bau (05.09.2026) las das **niemand** — die
 * Markierung war geschrieben und unsichtbar. Das ist dieselbe halbe Änderung,
 * die 0.10.165 hinterlassen hatte, nur eine Ebene tiefer: eine Warnung, die
 * kein Lesepfad zeigt, ist Stille.
 *
 * Diese Prüfungen halten den Lesepfad fest.
 */

import { describe, it, expect } from 'vitest';
import { confidenceBadge } from '../confidence.js';

describe('confidenceBadge — die gefallene Pruefung schlaegt alles', () => {
  it('zeigt den Fehlschlag mit Datum', () => {
    const b = confidenceBadge(0.4, 90, undefined, { am: '2026-09-05T10:00:00Z' });
    expect(b).toContain('CHECK FAILED');
    expect(b).toContain('2026-09-05');
  });

  it('nennt den Befund, wenn einer da ist', () => {
    const b = confidenceBadge(0.4, 90, undefined,
      { am: '2026-09-05', befund: 'Port 3095 antwortet nicht mehr' });
    expect(b).toContain('Port 3095 antwortet nicht mehr');
  });

  /**
   * Die tragende Pruefung. Eine Lektion von gestern hat Zuversicht 1,0 und
   * bekaeme sonst ein gruenes Haekchen — auf etwas, das jemand nachweislich
   * nicht mehr vorgefunden hat. Frisch und fraglich schliessen sich nicht aus.
   */
  it('schlaegt auch die volle Zuversicht', () => {
    const b = confidenceBadge(1.0, 0, undefined, { am: '2026-09-05', befund: 'weg' });
    expect(b).not.toBe('✅');
    expect(b).toContain('CHECK FAILED');
  });

  it('ohne Fehlschlag bleibt alles wie vorher', () => {
    expect(confidenceBadge(1.0, 0)).toBe('✅');
    expect(confidenceBadge(0.8, 7)).toContain('verify before applying');
    expect(confidenceBadge(0.4, 90)).toContain('STALE');
  });

  it('ein leeres Datum zaehlt nicht als Fehlschlag', () => {
    expect(confidenceBadge(1.0, 0, undefined, { am: '' })).toBe('✅');
    expect(confidenceBadge(1.0, 0, undefined, {})).toBe('✅');
  });

  it('kappt einen langen Befund, statt die Zeile zu sprengen', () => {
    const b = confidenceBadge(0.4, 90, undefined,
      { am: '2026-09-05', befund: 'x'.repeat(500) });
    expect(b.length).toBeLessThan(220);
  });

  it('zeigt den Pruefbefehl NICHT im Fehlschlag — er hat ja gerade versagt', () => {
    const b = confidenceBadge(0.4, 90, 'curl -s http://127.0.0.1:3220/bereit',
      { am: '2026-09-05', befund: 'HTTP 502' });
    expect(b).not.toContain('curl');
  });
});
