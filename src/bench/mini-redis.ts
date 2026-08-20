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
 */

import { EventEmitter } from 'node:events';

export class MiniRedis {
  store = new Map<string, string>();

  set(k: string, v: string): void { this.store.set(k, v); }

  async get(k: string): Promise<string | null> { return this.store.get(k) ?? null; }

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
}

/** Fuellt einen MiniRedis mit Lektionen unter dem echten Schluesselmuster. */
export function mitLektionen(lektionen: Array<{ topic: string }>): MiniRedis {
  const r = new MiniRedis();
  for (const l of lektionen) r.set(`cachly:lesson:best:${l.topic}`, JSON.stringify(l));
  return r;
}
