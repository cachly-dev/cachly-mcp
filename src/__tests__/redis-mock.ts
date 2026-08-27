/**
 * Geteilter In-Memory-Redis-Mock fuer Handler-Tests.
 *
 * Extrahiert am 25.08.2026 aus brain-flow.test.ts (Karte 5hlj9vvxeopp).
 * Zehn Testdateien tragen noch je eine EIGENE Kopie dieser Klasse —
 * neue Tests importieren von hier, die Angleichung der zehn ist eine
 * eigene Aufgabe (Fehlerklasse zweite Wahrheit, bewusst nicht en passant).
 */
import { EventEmitter } from 'node:events';

export class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets  = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
    // Honor a trailing 'NX' flag so first-wins semantics (born_at, first_recall_at) work.
    if (opts.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const next = parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start < 0 ? list.length + start : start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start < 0 ? list.length + start : start, end));
    return 'OK';
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  // GROW-046: Der Doppelgaenger muss koennen, was der Code benutzt. Fehlte
  // hincrby/hgetall, warf schon der AUFRUF — und ein .catch() faengt das nicht,
  // weil der Fehler nicht aus einer Zusage kommt, sondern aus "ist keine
  // Funktion".
  /*
   * Werte koennen Zahlen ODER Zeichenketten sein.
   *
   * Bis zum 27.08.2026 nur Zahlen — die Karte kannte nur `hincrby`. Der
   * Zurueckhaltungs-Messstand fuellt hier aber die Fehlertext-Tueren ein, und
   * die sind gepackte Zeichenketten. `hgetall` gibt ohnehin schon `String(v)`
   * zurueck, der Typ war also enger als das Verhalten.
   */
  private hashes = new Map<string, Map<string, string | number>>();

  /** Felder setzen, im Wechsel Feld/Wert — wie ioredis. */
  async hset(key: string, ...felder: string[]): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, string | number>();
    let neu = 0;
    for (let i = 0; i + 1 < felder.length; i += 2) {
      if (!h.has(felder[i])) neu++;
      h.set(felder[i], felder[i + 1]);
    }
    this.hashes.set(key, h);
    return neu;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, string | number>();
    const next = Number(h.get(field) ?? 0) + by;
    h.set(field, next);
    this.hashes.set(key, h);
    return next;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries([...h.entries()].map(([f, v]) => [f, String(v)]));
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async incrbyfloat(key: string, increment: number): Promise<string> {
    const cur = parseFloat(this.store.get(key) ?? '0');
    const next = cur + increment;
    this.store.set(key, String(next));
    return String(next);
  }

  async expire(_key: string, _ttl: number): Promise<number> { return 1; }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) { if (this.store.delete(k)) count++; }
    return count;
  }

  /** Simplified scanStream: returns all matching keys in a single 'data' event. */
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => {
      emitter.emit('data', matches);
      emitter.emit('end');
    });
    return emitter;
  }

  /** Minimal pipeline: batches GET calls, returns [err, value][] */
  pipeline() {
    const commands: Array<{ cmd: string; key: string }> = [];
    const store = this.store;
    return {
      get(key: string) { commands.push({ cmd: 'get', key }); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        const out: Array<[null, string | null]> = [];
        for (const c of commands) {
          out.push([null, store.get(c.key) ?? null]);
        }
        return out;
      },
    };
  }

  // Expose raw store for assertions
  _getStore() { return this.store; }
  _getLists() { return this.lists; }
  _getSets()  { return this.sets; }
}
