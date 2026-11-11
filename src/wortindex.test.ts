import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { keywordSearch, wortindexEntwerten, wortindexStand } from './search.js';

/**
 * Der stehende Wortindex — und der Beweis, dass er auch wieder loslaesst.
 *
 * ── Warum diese Datei ──────────────────────────────────────────────────────
 *
 * Ein Zwischenspeicher ist die bequemste Art, eine stille Verschlechterung
 * einzubauen: er macht alles schneller und manches falsch, und beides sieht
 * von aussen gleich aus. Deshalb prueft diese Datei BEIDE Richtungen —
 * dass er greift UND dass er losgelassen wird.
 *
 * Gemessen wird ueber die Zahl der Speicherzugriffe: ein Bestand, der steht,
 * liest nicht noch einmal.
 */

/** Ein Speicher, der mitzaehlt, wie oft er gelesen wurde. */
class ZaehlenderRedis {
  store = new Map<string, string>();
  scans = 0;
  gets = 0;

  set(k: string, v: string): void { this.store.set(k, v); }

  scanStream(o: { match: string }): EventEmitter {
    this.scans++;
    const e = new EventEmitter();
    const p = o.match.replace('*', '');
    const m = [...this.store.keys()].filter((k) => k.startsWith(p));
    setImmediate(() => { e.emit('data', m); e.emit('end'); });
    return e;
  }

  pipeline(): { get(k: string): unknown; exec(): () => Promise<Array<[null, string | null]>> } | {
    get(k: string): unknown; exec(): Promise<Array<[null, string | null]>>;
  } {
    const c: string[] = [];
    // Pfeilfunktionen statt `const self = this`: der Zaehler gehoert diesem
    // Speicher, nicht dem zurueckgegebenen Objekt.
    const zaehle = (n: number): void => { this.gets += n; };
    const lies = (k: string): string | null => this.store.get(k) ?? null;
    return {
      get(k: string) { c.push(k); return this; },
      exec: async (): Promise<Array<[null, string | null]>> => {
        zaehle(c.length);
        return c.map((k) => [null, lies(k)] as [null, string | null]);
      },
    };
  }
}

const lektion = (topic: string, text: string): string =>
  JSON.stringify({ topic, outcome: 'success', what_worked: text, ts: new Date().toISOString() });

describe('stehender Wortindex', () => {
  beforeEach(() => { wortindexEntwerten(); });

  it('liest den Bestand beim zweiten Mal nicht noch einmal', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll beim Ausrollen'));
    r.set('cachly:lesson:best:auth:token', lektion('auth:token', 'Das Token war abgelaufen'));

    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platte voll', 5);
    const nachErsterFrage = r.gets;
    expect(nachErsterFrage).toBeGreaterThan(0);

    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'token abgelaufen', 5);
    expect(r.gets, 'die zweite Frage hat den Bestand erneut gelesen').toBe(nachErsterFrage);
  });

  it('liefert beim zweiten Mal dasselbe Ergebnis wie beim ersten', async () => {
    // Schneller ist wertlos, wenn es dabei etwas anderes findet.
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll beim Ausrollen'));
    r.set('cachly:lesson:best:auth:token', lektion('auth:token', 'Das Token war abgelaufen'));

    const ersteAntwort = await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platte voll', 5);
    const zweiteAntwort = await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platte voll', 5);
    expect(zweiteAntwort.map((m) => m.key)).toEqual(ersteAntwort.map((m) => m.key));
  });

  it('GEGENPROBE: nach dem Entwerten wird wieder gelesen', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll'));

    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platte', 5);
    const vorher = r.gets;

    wortindexEntwerten();
    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platte', 5);
    expect(r.gets, 'nach dem Entwerten wurde NICHT neu gelesen').toBeGreaterThan(vorher);
  });

  it('findet eine frisch gelernte Lektion, sobald entwertet wurde', async () => {
    // Der Fall, um den es wirklich geht: gerade gelernt, sofort gesucht.
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:alt:eintrag', lektion('alt:eintrag', 'Ein alter Eintrag ueber Zeitzonen'));
    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'fail2ban gebannt', 5);

    r.set('cachly:lesson:best:neu:fail2ban', lektion('neu:fail2ban', 'fail2ban hat den Deploy-Kanal gebannt'));
    wortindexEntwerten();

    const treffer = await keywordSearch(r as never, ['cachly:lesson:best:*'], 'fail2ban gebannt', 5);
    expect(treffer.map((m) => m.key)).toContain('cachly:lesson:best:neu:fail2ban');
  });

  it('haelt Bestaende zu verschiedenen Mustern auseinander', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:a', lektion('a', 'Erster Eintrag ueber Platten'));
    r.set('cachly:ctx:b', JSON.stringify({ content: 'Zweiter Eintrag ueber Platten' }));

    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'platten', 5);
    const nachLektionen = r.gets;
    // Ein anderes Muster ist ein anderer Bestand — er darf den ersten nicht
    // benutzen, sonst faende eine Kontextsuche Lektionen und umgekehrt.
    await keywordSearch(r as never, ['cachly:ctx:*'], 'platten', 5);
    expect(r.gets).toBeGreaterThan(nachLektionen);
    expect(wortindexStand()).toBe(2);
  });

  it('ZWEI VERBINDUNGEN TEILEN SICH NICHTS', async () => {
    // Der schwerste Fehler dieses Umbaus, gefunden am 20.08.2026 von zwei
    // bestehenden Tests: der erste Entwurf benannte den Bestand NUR nach dem
    // Suchmuster. Derselbe MCP-Prozess bedient aber mehrere Instanzen, und
    // `cachly:lesson:best:*` heisst in jeder etwas anderes — die Lektionen der
    // einen Kanzlei waeren an die naechste ausgeliefert worden.
    const kanzleiA = new ZaehlenderRedis();
    kanzleiA.set('cachly:lesson:best:a:geheim', lektion('a:geheim', 'Mandant Meier zahlt nicht puenktlich'));
    const kanzleiB = new ZaehlenderRedis();
    kanzleiB.set('cachly:lesson:best:b:eigenes', lektion('b:eigenes', 'Unsere Lohnbuchhaltung laeuft montags'));

    await keywordSearch(kanzleiA as never, ['cachly:lesson:best:*'], 'mandant meier', 5);
    const beiB = await keywordSearch(kanzleiB as never, ['cachly:lesson:best:*'], 'mandant meier', 5);

    expect(beiB.map((m) => m.key), 'Kanzlei B sieht eine Lektion von Kanzlei A').not.toContain(
      'cachly:lesson:best:a:geheim',
    );
    expect(kanzleiB.gets, 'Kanzlei B hat gar nicht erst gelesen').toBeGreaterThan(0);
  });

  it('entwerten raeumt wirklich alles weg', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:a', lektion('a', 'Ein Eintrag'));
    await keywordSearch(r as never, ['cachly:lesson:best:*'], 'eintrag', 5);
    expect(wortindexStand()).toBeGreaterThan(0);
    wortindexEntwerten();
    expect(wortindexStand()).toBe(0);
  });
});

/**
 * Nach Ablauf der Minute (11.11.2026, bestand-frische.ts).
 *
 * Bis dahin wartete jede Frage nach Ablauf der Minute auf den ganzen Neubau —
 * gemessen an einem echten Brain mit rund 1.250 Lektionen ueber das Netz: 77
 * bis 142 s je Aufruf. Seitdem antwortet der abgelaufene Bestand sofort und
 * der Neubau laeuft daneben. Eigenes Schreiben (entwerten) und der Messmodus
 * warten weiter.
 */
describe('Wortindex nach Ablauf der Minute', () => {
  const muster = ['cachly:lesson:best:*'];
  const naechsterTakt = () => new Promise((fertig) => setImmediate(fertig));
  const findet = async (r: ZaehlenderRedis, frage: string, key: string) =>
    (await keywordSearch(r as never, muster, frage, 5)).some((m) => m.key === key);

  beforeEach(() => { wortindexEntwerten(); });
  afterEach(() => { vi.useRealTimers(); delete process.env.CACHLY_RECALL_NUR_LESEN; });

  it('der abgelaufene Bestand antwortet sofort, der neue kommt im Hintergrund', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll'));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1000 });
    await keywordSearch(r as never, muster, 'platte', 5);

    r.set('cachly:lesson:best:netz:kabel', lektion('netz:kabel', 'Das Kabel war gezogen'));
    vi.setSystemTime(Date.now() + 61_000);
    expect(await findet(r, 'kabel gezogen', 'cachly:lesson:best:netz:kabel'),
      'die Frage hat auf den Neubau gewartet').toBe(false);

    for (let i = 0; i < 5; i++) await naechsterTakt();
    expect(await findet(r, 'kabel gezogen', 'cachly:lesson:best:netz:kabel'),
      'der Neubau im Hintergrund kam nie an').toBe(true);
  });

  it('im Messmodus wartet die Frage auf den Neubau', async () => {
    process.env.CACHLY_RECALL_NUR_LESEN = '1';
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll'));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1000 });
    await keywordSearch(r as never, muster, 'platte', 5);

    r.set('cachly:lesson:best:netz:kabel', lektion('netz:kabel', 'Das Kabel war gezogen'));
    vi.setSystemTime(Date.now() + 61_000);
    expect(await findet(r, 'kabel gezogen', 'cachly:lesson:best:netz:kabel')).toBe(true);
  });

  it('ein Neubau, der VOR dem Entwerten begann, wird nicht abgewartet — er kennt das Neue nicht', async () => {
    const r = new ZaehlenderRedis();
    r.set('cachly:lesson:best:ci:platte', lektion('ci:platte', 'Die Platte war voll'));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1000 });
    await keywordSearch(r as never, muster, 'platte', 5);

    // Abgelaufen: die Frage stoesst einen Neubau an und antwortet sofort.
    vi.setSystemTime(Date.now() + 61_000);
    await keywordSearch(r as never, muster, 'platte', 5);
    // Waehrend dieser Neubau laeuft, wird gelernt und entwertet.
    r.set('cachly:lesson:best:neu:fail2ban', lektion('neu:fail2ban', 'fail2ban hat den Deploy-Kanal gebannt'));
    wortindexEntwerten();

    expect(await findet(r, 'fail2ban gebannt', 'cachly:lesson:best:neu:fail2ban'),
      'die Frage hat den alten Neubau abgewartet und die neue Lektion uebersehen').toBe(true);
  });
});
