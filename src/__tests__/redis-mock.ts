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

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    // Redis-Semantik: mehrere Werte werden einzeln vorn eingefuegt.
    for (const v of values) list.unshift(v);
    this.lists.set(key, list);
    return list.length;
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

  /**
   * Ist dieser Wert in der Menge?
   *
   * Ergaenzt am 27.08.2026. Er fehlte, und `getScopes` ruft ihn — mit dem
   * Ergebnis, dass jede Gruppenzugehoerigkeit in den Proben LEER war. Eine
   * Probe, die pruefen wollte, ob ein Gruppenmitglied seine Lektion sieht,
   * fiel deshalb rot aus, obwohl das Produkt richtig lag.
   *
   * Genau die Falle, vor der die eigene Regel warnt: erst pruefen, was die
   * Attrappe wirklich kann, bevor man aus ihrem Verhalten auf das Produkt
   * schliesst.
   */
  async sismember(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.has(member) ? 1 : 0;
  }

  // Karte 8jnckd2stesi: der write-ahead-Vermerk traegt sich nach Erfolg mit
  // srem wieder aus — der Doppelgaenger muss koennen, was der Code benutzt.
  async srem(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key);
    if (!s) return 0;
    let removed = 0;
    for (const m of members) { if (s.delete(m)) removed++; }
    return removed;
  }

  async spop(key: string, count?: number): Promise<string[] | string | null> {
    const s = this.sets.get(key);
    if (!s || s.size === 0) return count === undefined ? null : [];
    const n = count ?? 1;
    const raus: string[] = [];
    for (const m of [...s].slice(0, n)) { s.delete(m); raus.push(m); }
    return count === undefined ? (raus[0] ?? null) : raus;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  // 0.10.151: der Heiler LIEST jetzt (srandmember) statt zu entnehmen (spop)
  // — der Vermerk faellt erst nach nachweislich geschriebenem Vektor.
  async srandmember(key: string, count?: number): Promise<string[] | string | null> {
    const s = this.sets.get(key);
    if (!s || s.size === 0) return count === undefined ? null : [];
    const n = count ?? 1;
    const raus = [...s].slice(0, n);
    return count === undefined ? (raus[0] ?? null) : raus;
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

  /**
   * Simplified cursor scan: `scan(cursor, 'MATCH', pattern, 'COUNT', n)`.
   * Gibt alle Treffer auf einer Seite zurueck (Cursor '0' = fertig), wie
   * scanStream. Reicht fuer die Tests; die echte Redis paginiert.
   */
  async scan(_cursor: string | number, ...rest: Array<string | number>): Promise<[string, string[]]> {
    let match = '*';
    for (let i = 0; i < rest.length - 1; i++) {
      if (String(rest[i]).toUpperCase() === 'MATCH') match = String(rest[i + 1]);
    }
    const pattern = match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter((k) => regex.test(k));
    return ['0', matches];
  }

  /** Minimal pipeline: batches GET/SET/SADD calls, returns [err, value][] */
  pipeline() {
    const commands: Array<{ cmd: string; key: string; wert?: string }> = [];
    const selbst = this;
    return {
      get(key: string) { commands.push({ cmd: 'get', key }); return this; },
      set(key: string, wert: string) { commands.push({ cmd: 'set', key, wert }); return this; },
      sadd(key: string, wert: string) { commands.push({ cmd: 'sadd', key, wert }); return this; },
      async exec(): Promise<Array<[null, unknown]>> {
        const out: Array<[null, unknown]> = [];
        for (const c of commands) {
          if (c.cmd === 'get') out.push([null, selbst.store.get(c.key) ?? null]);
          else if (c.cmd === 'set') { selbst.store.set(c.key, c.wert as string); out.push([null, 'OK']); }
          else out.push([null, await selbst.sadd(c.key, c.wert as string)]);
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
