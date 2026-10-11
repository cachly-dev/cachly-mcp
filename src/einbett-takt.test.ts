// Der Einbett-Takt teilt das Kontingent (60 Einbettungen je Minute) mit dem
// Lektions-Import. Anlass und Regeln: einbett-takt.ts.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ABSTAND_HINTERGRUND_MS, einbettTakt } from './einbett-takt.js';

/** Eine Uhr, die nur beim Schlafen weiterlaeuft, und ein Protokoll der Pausen. */
function uhr() {
  let t = 1_000_000;
  const pausen: number[] = [];
  return {
    jetzt: () => t,
    schlafe: async (ms: number) => { pausen.push(ms); t += ms; },
    vergeht: (ms: number) => { t += ms; },
    pausen,
  };
}

describe('Hintergrund: hoechstens eine Einbettung je Abstand', () => {
  it('die erste wartet nicht, jede weitere den Rest des Abstands', async () => {
    const u = uhr();
    const takt = einbettTakt({ hintergrund: true, jetzt: u.jetzt, schlafe: u.schlafe });
    await takt.warte();
    u.vergeht(500);
    await takt.warte();
    await takt.warte();
    expect(u.pausen).toEqual([ABSTAND_HINTERGRUND_MS - 500, ABSTAND_HINTERGRUND_MS]);
  });

  it('war die letzte lange genug her, wartet nichts', async () => {
    const u = uhr();
    const takt = einbettTakt({ hintergrund: true, jetzt: u.jetzt, schlafe: u.schlafe });
    await takt.warte();
    u.vergeht(ABSTAND_HINTERGRUND_MS + 1);
    await takt.warte();
    expect(u.pausen).toEqual([]);
  });

  it('der Abstand laesst gut die Haelfte des Kontingents frei (60 je Minute)', () => {
    expect(60_000 / ABSTAND_HINTERGRUND_MS).toBeLessThanOrEqual(30);
  });
});

describe('Eigener Aufruf: kein Warten', () => {
  it('ruft jemand index_project selbst auf, gibt es keine Pause', async () => {
    const u = uhr();
    const takt = einbettTakt({ hintergrund: false, jetzt: u.jetzt, schlafe: u.schlafe });
    for (let i = 0; i < 5; i++) await takt.warte();
    expect(u.pausen).toEqual([]);
  });
});

describe('429 beendet das Einbetten fuer diesen Lauf', () => {
  it('nach einem 429 darf nichts mehr eingebettet werden', () => {
    const takt = einbettTakt({ hintergrund: true });
    expect(takt.darf()).toBe(true);
    takt.fehler(Object.assign(new Error('Cachly embed API error 429'), { status: 429 }));
    expect(takt.darf()).toBe(false);
  });

  it('andere Fehler (Zeitlimit, 503, Netz) beenden es nicht', () => {
    const takt = einbettTakt({ hintergrund: true });
    takt.fehler(Object.assign(new Error('503'), { status: 503 }));
    takt.fehler(new Error('fetch failed'));
    takt.fehler(undefined);
    expect(takt.darf()).toBe(true);
  });
});

describe('Anschluss in index_project', () => {
  const cache = readFileSync(new URL('./handlers/cache.ts', import.meta.url), 'utf8');
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

  it('index_project fragt den Takt vor jeder Einbettung und meldet Fehler zurueck', () => {
    expect(cache).toMatch(/if \(canEmbed && takt\.darf\(\)\)/);
    expect(cache).toMatch(/await takt\.warte\(\)/);
    expect(cache).toMatch(/takt\.fehler\(/);
  });

  it('der automatische Lauf beim Sitzungsstart laeuft als Hintergrund', () => {
    expect(index).toMatch(/handleTool\('index_project', \{[^}]*hintergrund: true/);
  });
});
