/**
 * Der zweite Sperrschluessel: dieselbe Datei statt derselben Woerter.
 *
 * Warum es diesen Test gibt. Der Ersetzungs-Vorschlag sah bis zum 04.09.2026
 * nur die fuenf besten WORT-Treffer. Das ist die falsche Auswahl, und der
 * Grund ist banal: eine Lektion, die eine aeltere ueberholt, benutzt andere
 * Woerter. "Laeuft jetzt ueber TEI" ersetzt "laeuft ueber Ollama" — gemeinsame
 * Woerter: fast keine. Von 29 erreichbaren Paaren kamen 2 durch das Tor.
 *
 * Gemessen an 735 echten Lektionen, VOR dem Bau:
 *   - 61 der 90 Korrektur-Lektionen tragen `file_paths` (67,8 %).
 *   - Kandidatenkreis je Korrektur-Lektion: Median 1, Mittel 3,0, Max 19.
 *   - Haeufigster Pfad `.github/workflows/ci.yml` in 26 Lektionen — kein Magnet.
 *
 * Geprueft wird hier die Auswahl, nicht die Heuristik danach: findet der
 * Schluessel den Vorgaenger, den die Wortsuche nicht findet, und laesst er
 * alles andere liegen?
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { treffeUeberDateipfad, PFAD_TREFFER_GRENZE } from '../search.js';

class MiniRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  pipeline() {
    const holen: string[] = [];
    return {
      get: (key: string) => { holen.push(key); return this as unknown as never; },
      exec: async () => holen.map((k) => [null, this.store.get(k) ?? null]),
    };
  }
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const muster = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${muster}$`);
    const treffer = [...this.store.keys()].filter((k) => regex.test(k));
    setImmediate(() => { emitter.emit('data', treffer); emitter.emit('end'); });
    return emitter;
  }
}

const MUSTER = ['cachly:lesson:best:*'];

function lege(r: MiniRedis, topic: string, what_worked: string, file_paths: string[]) {
  r.store.set(
    `cachly:lesson:best:${topic}`,
    JSON.stringify({ topic, what_worked, file_paths, ts: '2026-09-01T00:00:00Z' }),
  );
}

/** Jeder Test bekommt eine eigene Attrappe — der Wortbestand haengt daran. */
function frisch(): MiniRedis {
  return new MiniRedis();
}

type Redis = Parameters<typeof treffeUeberDateipfad>[0];
const alsRedis = (r: MiniRedis) => r as unknown as Redis;

describe('treffeUeberDateipfad — der Sperrschluessel', () => {
  it('findet den Vorgaenger, der kein einziges Wort teilt', async () => {
    const r = frisch();
    lege(r, 'embedding:ollama-durchsatz',
      'Die Einbettung laeuft ueber Ollama, acht gleichzeitige Anfragen.',
      ['api/internal/handler/embed_handler.go']);
    lege(r, 'ci:runner-anzahl', 'Fuenf Runner auf node-4.', ['.github/workflows/ci.yml']);

    const treffer = await treffeUeberDateipfad(
      alsRedis(r), MUSTER, ['api/internal/handler/embed_handler.go'],
    );

    expect(treffer.map((t) => t.key))
      .toEqual(['cachly:lesson:best:embedding:ollama-durchsatz']);
  });

  it('Gegenprobe: ohne gemeinsamen Pfad kein Treffer', async () => {
    const r = frisch();
    lege(r, 'ci:runner-anzahl', 'Fuenf Runner auf node-4.', ['.github/workflows/ci.yml']);

    const treffer = await treffeUeberDateipfad(alsRedis(r), MUSTER, ['web/lib/landing.ts']);
    expect(treffer).toEqual([]);
  });

  it('ein Pfad in der Prosa ist kein Treffer — nur das Feld file_paths zaehlt', async () => {
    const r = frisch();
    r.store.set('cachly:lesson:best:erwaehnung', JSON.stringify({
      topic: 'erwaehnung',
      what_worked: 'Siehe auch web/lib/landing-constants.ts, dort steht die Zahl.',
      file_paths: ['api/main.go'],
    }));

    const treffer = await treffeUeberDateipfad(
      alsRedis(r), MUSTER, ['web/lib/landing-constants.ts'],
    );
    expect(treffer).toEqual([]);
  });

  it('vergleicht ohne Ruecksicht auf Gross- und Kleinschreibung', async () => {
    const r = frisch();
    lege(r, 'a', 'x', ['SDK/MCP/src/Handlers/Brain.ts']);

    const treffer = await treffeUeberDateipfad(
      alsRedis(r), MUSTER, ['sdk/mcp/src/handlers/brain.ts'],
    );
    expect(treffer).toHaveLength(1);
  });

  it('ohne eigene Pfade wird gar nicht erst gesucht', async () => {
    const r = frisch();
    lege(r, 'a', 'x', ['api/main.go']);

    expect(await treffeUeberDateipfad(alsRedis(r), MUSTER, [])).toEqual([]);
    expect(await treffeUeberDateipfad(alsRedis(r), MUSTER, ['   '])).toEqual([]);
  });

  it('haelt die Grenze ein — ein Magnet-Pfad flutet den Vorschlag nicht', async () => {
    const r = frisch();
    for (let i = 0; i < PFAD_TREFFER_GRENZE + 15; i++) {
      lege(r, `ci:lektion-${i}`, `Nummer ${i}`, ['.github/workflows/ci.yml']);
    }

    const treffer = await treffeUeberDateipfad(
      alsRedis(r), MUSTER, ['.github/workflows/ci.yml'],
    );
    expect(treffer).toHaveLength(PFAD_TREFFER_GRENZE);
  });

  it('einer von mehreren gemeinsamen Pfaden genuegt', async () => {
    const r = frisch();
    lege(r, 'a', 'x', ['api/main.go', 'api/other.go']);

    const treffer = await treffeUeberDateipfad(
      alsRedis(r), MUSTER, ['web/app.tsx', 'api/other.go'],
    );
    expect(treffer).toHaveLength(1);
  });

  it('kaputtes JSON kippt die Suche nicht', async () => {
    const r = frisch();
    r.store.set('cachly:lesson:best:kaputt', '{ das ist kein JSON');
    lege(r, 'heil', 'x', ['api/main.go']);

    const treffer = await treffeUeberDateipfad(alsRedis(r), MUSTER, ['api/main.go']);
    expect(treffer.map((t) => t.key)).toEqual(['cachly:lesson:best:heil']);
  });

  it('file_paths als einzelner String statt Liste zaehlt auch', async () => {
    const r = frisch();
    r.store.set('cachly:lesson:best:einzel', JSON.stringify({
      topic: 'einzel', what_worked: 'x', file_paths: 'api/main.go',
    }));

    const treffer = await treffeUeberDateipfad(alsRedis(r), MUSTER, ['api/main.go']);
    expect(treffer).toHaveLength(1);
  });

  it('leerer Bestand gibt eine leere Liste, keinen Fehler', async () => {
    const treffer = await treffeUeberDateipfad(alsRedis(frisch()), MUSTER, ['api/main.go']);
    expect(treffer).toEqual([]);
  });

  it('erfindet keine Bewertung — score und wortBelege bleiben 0', async () => {
    const r = frisch();
    lege(r, 'a', 'x', ['api/main.go']);

    const [t] = await treffeUeberDateipfad(alsRedis(r), MUSTER, ['api/main.go']);
    expect(t.score).toBe(0);
    expect(t.wortBelege).toBe(0);
    expect(t.matchedWords).toEqual([]);
  });
});
