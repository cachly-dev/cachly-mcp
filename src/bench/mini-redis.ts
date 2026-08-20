/**
 * Ein Speicher-Ersatz fuer den Bench: haelt Lektionen im Arbeitsspeicher und
 * kann genau das, was `keywordSearch` von Redis verlangt.
 *
 * ── Warum als eigenes Modul ─────────────────────────────────────────────────
 *
 * Diese Klasse stand als Kopie in alles-zusammen.ts und waere in jedem
 * weiteren Messwerkzeug noch einmal entstanden. Eine Wahrheit an mehreren
 * Orten ist die Fehlerklasse, die uns hier am haeufigsten trifft — also steht
 * sie einmal.
 *
 * ── Erweitert am 20.08.2026 ────────────────────────────────────────────────
 *
 * Bis dahin konnte diese Klasse nur, was der Wortabgleich braucht. Der
 * Messstand mit 17 Lektionen kam damit aus; ein Messstand mit 499 Lektionen
 * und echten Vektoren nicht. Dazu fehlten `scan`, `mget`, `hgetall` und
 * `hset` — also genau das, was Vektorbestand, Eingangsbestand und
 * Seltenheitsbestand vom echten Speicher verlangen.
 *
 * Der Grund, das hier zu ergaenzen statt einen zweiten Ersatz zu bauen: nur so
 * laeuft im Bench DIESELBE Auswertung wie am echten Bestand. Ein Messstand mit
 * eigener Nachbildung misst am Ende die Nachbildung.
 */

import { EventEmitter } from 'node:events';

export class MiniRedis {
  store = new Map<string, string>();

  hashes = new Map<string, Record<string, string>>();

  set(k: string, v: string): void { this.store.set(k, v); }

  async get(k: string): Promise<string | null> { return this.store.get(k) ?? null; }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((k) => this.store.get(k) ?? null);
  }

  async hgetall(k: string): Promise<Record<string, string>> {
    return this.hashes.get(k) ?? {};
  }

  hset(k: string, ...felder: string[]): void {
    const h = this.hashes.get(k) ?? {};
    for (let i = 0; i + 1 < felder.length; i += 2) h[felder[i]] = felder[i + 1];
    this.hashes.set(k, h);
  }

  /**
   * Wie `SCAN`, aber in einem Rutsch: Cursor kommt als '0' zurueck.
   *
   * Der echte SCAN liefert haeppchenweise und kann Schluessel doppelt zeigen.
   * Hier ist beides unnoetig — die Aufrufer sammeln ohnehin in eine Menge.
   */
  async scan(_cursor: string, _match: string, muster: string, ..._rest: unknown[]): Promise<[string, string[]]> {
    const p = muster.replace('*', '');
    const aus = [
      ...[...this.store.keys()].filter((k) => k.startsWith(p)),
      ...[...this.hashes.keys()].filter((k) => k.startsWith(p)),
    ];
    return ['0', aus];
  }

  scanStream(o: { match: string }): EventEmitter {
    const e = new EventEmitter();
    const p = o.match.replace('*', '');
    const m = [...this.store.keys()].filter((k) => k.startsWith(p));
    setImmediate(() => { e.emit('data', m); e.emit('end'); });
    return e;
  }

  pipeline(): { get(k: string): unknown; exec(): Promise<Array<[null, string | null]>> } {
    const c: string[] = [];
    const s = this.store;
    return {
      get(k: string) { c.push(k); return this; },
      async exec() { return c.map((k) => [null, s.get(k) ?? null] as [null, string | null]); },
    };
  }

  /** Damit dieselbe Auswertung auch hier aufgeraeumt beenden kann. */
  disconnect(): void { /* nichts zu trennen */ }
}

/** Fuellt einen MiniRedis mit Lektionen unter dem echten Schluesselmuster. */
export function mitLektionen(lektionen: Array<{ topic: string }>): MiniRedis {
  const r = new MiniRedis();
  for (const l of lektionen) r.set(`cachly:lesson:best:${l.topic}`, JSON.stringify(l));
  return r;
}
