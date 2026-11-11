/**
 * Die parallele Kanten-Suche liefert dasselbe wie die alte Schleife (04.11.2026).
 *
 * Die alte Schleife aus smart_recall steht hier woertlich als Vergleich: je Wort
 * ein SCAN (je Stapel die ersten 5 Knoten), die ersten 12 Knoten, je Knoten die
 * ersten 6 Kanten, nur "fixes" ab 0,35, jede Lektion einmal. Gemessen wird nur,
 * ob die angewendeten Kanten und Inhalte in derselben Reihenfolge herauskommen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { holeKantenVorrat, gemerkterTarif, vergissTarife, type KantenRedis } from '../kanten-vorrat.js';
import type { CKGEdge } from '../ckg.js';

/** Ein Bestand mit SCAN in Stapeln, Mengen und Zeichenketten; zaehlt gleichzeitige Befehle. */
class Bestand implements KantenRedis {
  werte = new Map<string, string>();
  mengen = new Map<string, string[]>();
  offen = 0;
  hoechstensGleichzeitig = 0;
  private async warte<T>(x: T): Promise<T> {
    this.offen++; this.hoechstensGleichzeitig = Math.max(this.hoechstensGleichzeitig, this.offen);
    await new Promise((r) => setTimeout(r, 1));
    this.offen--; return x;
  }
  scanStream(opts: { match: string; count: number }) {
    const muster = new RegExp('^' + opts.match.split('*').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const alle = [...this.werte.keys()].filter((k) => muster.test(k));
    const handler: Record<string, (x?: unknown) => void> = {};
    const strom = { on: (e: string, f: (x?: unknown) => void) => { handler[e] = f; return strom; } };
    // Wie ioredis: die Ereignisse kommen erst, nachdem der Aufrufer zugehoert hat.
    setTimeout(() => {
      void (async () => {
        for (let i = 0; i < alle.length; i += 3) handler.data?.(await this.warte(alle.slice(i, i + 3)));
        handler.end?.();
      })();
    }, 0);
    return strom as unknown as ReturnType<KantenRedis['scanStream']>;
  }
  smembers(k: string) { return this.warte(this.mengen.get(k) ?? []); }
  get(k: string) { return this.warte(this.werte.get(k) ?? null); }
}

/** Die Schleife aus smart_recall bis 0.10.229, nur ohne hybridMap. */
async function alteSchleife(redis: Bestand, woerter: string[]): Promise<Array<{ from: string; inhalt: string | null }>> {
  const kandidaten = new Set<string>();
  for (const token of woerter) {
    const s = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 20 });
    await new Promise<void>((res, rej) => {
      s.on('data', (batch: string[]) => { for (const k of batch.slice(0, 5)) kandidaten.add(k.replace('cachly:ckg:node:', '')); });
      s.on('end', res); s.on('error', rej);
    });
  }
  const gesehen = new Set<string>();
  const aus: Array<{ from: string; inhalt: string | null }> = [];
  for (const n of [...kandidaten].slice(0, 12)) {
    for (const ek of (await redis.smembers(`cachly:ckg:idx:to:${n}`)).slice(0, 6)) {
      const er = await redis.get(ek);
      if (!er) continue;
      const e = JSON.parse(er) as CKGEdge;
      if (e.edgeType !== 'fixes' || e.confidence < 0.35) continue;
      if (gesehen.has(e.from)) continue;
      gesehen.add(e.from);
      aus.push({ from: e.from, inhalt: await redis.get(`cachly:lesson:best:${e.from}`) });
    }
  }
  return aus;
}

/** Dieselbe Anwendung wie in brain.ts auf den Vorrat. */
function wendeAn(vorrat: Awaited<ReturnType<typeof holeKantenVorrat>>) {
  const gesehen = new Set<string>();
  const aus: Array<{ from: string; inhalt: string | null }> = [];
  for (const { kante: e, inhalt } of vorrat) {
    if (e.edgeType !== 'fixes' || e.confidence < 0.35) continue;
    if (gesehen.has(e.from)) continue;
    gesehen.add(e.from);
    aus.push({ from: e.from, inhalt });
  }
  return aus;
}

function bestand(): Bestand {
  const b = new Bestand();
  // 20 Knoten, davon viele zu "deadlock" und "postgres", ein paar fremde.
  for (let i = 0; i < 20; i++) {
    const thema = i % 3 === 0 ? `deadlock-${i}` : i % 3 === 1 ? `postgres-pool-${i}` : `css-${i}`;
    b.werte.set(`cachly:ckg:node:${thema}`, '{}');
    const kanten: string[] = [];
    for (let j = 0; j < 8; j++) {
      const ek = `cachly:ckg:edge:${i}:${j}`;
      const art = j % 4 === 0 ? 'causes' : 'fixes';
      b.werte.set(ek, JSON.stringify({ from: `fix:lektion-${(i * 3 + j) % 17}`, to: thema, edgeType: art, confidence: (j % 5) / 5 + 0.1 }));
      kanten.push(ek);
    }
    b.mengen.set(`cachly:ckg:idx:to:${thema}`, kanten);
  }
  for (let l = 0; l < 17; l++) if (l % 4 !== 0) b.werte.set(`cachly:lesson:best:fix:lektion-${l}`, `{"topic":"fix:lektion-${l}"}`);
  return b;
}

describe('holeKantenVorrat', () => {
  it('liefert dieselben Kanten und Inhalte in derselben Reihenfolge wie die alte Schleife', async () => {
    for (const woerter of [['deadlock', 'postgres'], ['postgres', 'deadlock', 'pool'], ['css'], ['nichts']]) {
      const b = bestand();
      const alt = await alteSchleife(b, woerter);
      const neu = wendeAn(await holeKantenVorrat(bestand(), woerter));
      expect(neu, woerter.join(',')).toEqual(alt);
      // Kein Vergleich zweier leerer Listen: ausser "nichts" liefert jede Frage Kanten, auch ohne Lektion.
      if (woerter[0] !== 'nichts') {
        expect(alt.length, woerter.join(',')).toBeGreaterThan(3);
        expect(alt.some((a) => a.inhalt === null), 'auch fehlende Lektionen kommen gleich heraus').toBe(true);
      }
    }
  });

  it('fragt den Speicher in grossen Schritten ab, nicht in 20er-Schritten (11.11.2026)', async () => {
    // 20 je Schritt kostete bei einem echten Brain 53-55 s je smart_recall.
    const b = bestand();
    const schritte: number[] = [];
    const scan = b.scanStream.bind(b);
    b.scanStream = (o) => { schritte.push(o.count); return scan(o); };
    await holeKantenVorrat(b, ['deadlock', 'postgres']);
    expect(schritte).toEqual([1000, 1000]);
  });

  it('nimmt aus einem grossen Stapel jeden Treffer in Reihenfolge, nicht nur die ersten 5', async () => {
    // Mit 1.000 je Schritt koennen in EINEM Stapel mehr als 5 Knoten passen;
    // die alte Grenze "5 je Stapel" haette dann Treffer abgeschnitten, die bei
    // 20 je Schritt mitgekommen waeren.
    const b = new Bestand();
    for (let i = 0; i < 8; i++) {
      b.werte.set(`cachly:ckg:node:deadlock-${i}`, '{}');
      b.werte.set(`cachly:ckg:edge:${i}`, JSON.stringify({ from: `fix:l-${i}`, to: `deadlock-${i}`, edgeType: 'fixes', confidence: 0.9 }));
      b.mengen.set(`cachly:ckg:idx:to:deadlock-${i}`, [`cachly:ckg:edge:${i}`]);
    }
    b.scanStream = (o) => {
      const alle = [...b.werte.keys()].filter((k) => k.startsWith('cachly:ckg:node:') && k.includes(o.match.split('*')[1]));
      const h: Record<string, (x?: unknown) => void> = {};
      const strom = { on: (e: string, f: (x?: unknown) => void) => { h[e] = f; return strom; } };
      setTimeout(() => { h.data?.(alle); h.end?.(); }, 0);
      return strom as unknown as ReturnType<KantenRedis['scanStream']>;
    };
    const vorrat = await holeKantenVorrat(b, ['deadlock']);
    expect(vorrat.map((f) => f.kante.from)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `fix:l-${i}`));
  });

  it('fragt gleichzeitig statt nacheinander', async () => {
    const b = bestand();
    await holeKantenVorrat(b, ['deadlock', 'postgres']);
    expect(b.hoechstensGleichzeitig).toBeGreaterThan(5);
  });
});

describe('gemerkterTarif', () => {
  beforeEach(() => vergissTarife());

  it('fragt je Instanz einmal, ein Fehlschlag wird nicht gemerkt', async () => {
    let rufe = 0;
    const holen = async () => { rufe++; return { tier: 'dev' }; };
    await gemerkterTarif('a', holen);
    await gemerkterTarif('a', holen);
    expect(rufe).toBe(1);
    await gemerkterTarif('b', holen);
    expect(rufe).toBe(2);

    let fehl = 0;
    const scheitert = async () => { fehl++; throw new Error('netz'); };
    expect(await gemerkterTarif('c', scheitert)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    await gemerkterTarif('c', scheitert);
    expect(fehl).toBe(2);
  });
});
