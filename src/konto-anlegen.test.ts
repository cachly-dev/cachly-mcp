import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUFTRAG_VERFAELLT_MS, SPERRE_VERALTET_MS, auftragLiegt, nimmAuftrag, schreibeAuftrag, sichereKonto,
  startwissenEingeschaltet, type KontoOptionen,
} from './konto-anlegen.js';
import { _sperreZuruecksetzen } from './sofort-test.js';
import { readInstanceId, readSavedApiKey } from './credentials.js';

/*
 * Befund 12.10.2026 (Probe mit dem echten Plugin, leerer Heimordner): Das
 * Konto entstand erst im MCP-Server beim ersten Werkzeugaufruf. Jetzt legt
 * schon der SessionStart-Hook es an — und damit koennen Hook und Server
 * gleichzeitig "kein Schluessel" sehen. Diese Tests halten fest, dass daraus
 * hoechstens EIN Konto wird.
 */

const SCHLUESSEL = 'cky_trial_konto0000000000000000000000';
const INSTANZ = '11111111-2222-3333-4444-555555555555';

let heim: string;
beforeEach(() => {
  _sperreZuruecksetzen();
  heim = mkdtempSync(join(tmpdir(), 'cachly-konto-'));
});
afterEach(() => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

interface Aufruf { url: string; ua: string }

/** Eine Gegenstelle, die zaehlt. `verzoegerungMs` laesst gleichzeitige Starts wirklich ueberlappen. */
function gegenstelle(opt: { status?: number; verzoegerungMs?: number } = {}) {
  const aufrufe: Aufruf[] = [];
  const holen = (async (url: string, init?: RequestInit) => {
    aufrufe.push({ url: String(url), ua: String((init?.headers as Record<string, string>)?.['User-Agent'] ?? '') });
    await new Promise((r) => setTimeout(r, opt.verzoegerungMs ?? 0));
    const status = opt.status ?? 201;
    return {
      ok: status < 300,
      json: async () => ({ api_key: SCHLUESSEL, instance_id: INSTANZ, trial_ends_at: '2026-10-26T12:00:00Z' }),
    };
  }) as unknown as typeof fetch;
  return { aufrufe, holen };
}

const opt = (holen: typeof fetch, extra: Partial<KontoOptionen> = {}): KontoOptionen => ({
  apiUrl: 'https://api.test',
  version: '0.10.185',
  home: heim,
  env: { CACHLY_QUELLE: 'claude-code-plugin' },
  fristMs: 3000,
  holen,
  ...extra,
});

const credentials = () => join(heim, '.cachly', 'credentials.json');
const sperre = () => join(heim, '.cachly', 'anlegen.lock');

describe('sichereKonto: ein Konto, nie zwei', () => {
  it('ohne Schluessel: genau ein Konto, Schluessel UND Instanz stehen in credentials.json, die Sperre ist frei', async () => {
    const g = gegenstelle();
    const e = await sichereKonto(opt(g.holen));

    expect(e.art).toBe('angelegt');
    expect(g.aufrufe.length).toBe(1);
    expect(g.aufrufe[0]!.url).toBe('https://api.test/auth/instant-trial');
    // Die Herkunft steht im ERSTEN Feld des User-Agent (sofort-test.ts).
    expect(g.aufrufe[0]!.ua).toBe('cachly-claude-code-plugin/0.10.185');
    expect(readSavedApiKey({ home: heim })).toBe(SCHLUESSEL);
    expect(readInstanceId({ home: heim })).toBe(INSTANZ);
    expect(existsSync(sperre())).toBe(false);
  });

  it('mit Schluessel: kein Konto, auch kein abgelaufener oder falscher', async () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(credentials(), JSON.stringify({ apiKey: 'cky_alt', instanceId: 'inst-alt' }));
    const g = gegenstelle();
    const e = await sichereKonto(opt(g.holen));

    expect(e).toEqual({ art: 'vorhanden', apiKey: 'cky_alt', instanzId: 'inst-alt' });
    expect(g.aufrufe.length).toBe(0);
  });

  it('zwei gleichzeitige Starts (Hook und Server): ein Konto, beide enden mit demselben Schluessel', async () => {
    // Die Anfrage dauert 300 ms: der zweite Start kommt mitten hinein.
    const g = gegenstelle({ verzoegerungMs: 300 });
    const [a, b] = await Promise.all([sichereKonto(opt(g.holen)), sichereKonto(opt(g.holen))]);

    expect(g.aufrufe.length, 'es wurde mehr als ein Konto angelegt').toBe(1);
    expect([a.art, b.art].sort()).toEqual(['angelegt', 'vorhanden']);
    const vorhanden = (a.art === 'vorhanden' ? a : b) as Extract<typeof a, { art: 'vorhanden' }>;
    expect(vorhanden.apiKey).toBe(SCHLUESSEL);
    // Der Wartende bekommt auch die Instanz — nie einen halben Stand.
    expect(vorhanden.instanzId).toBe(INSTANZ);
  });

  it('fuenf gleichzeitige Starts: weiter ein Konto', async () => {
    const g = gegenstelle({ verzoegerungMs: 200 });
    const alle = await Promise.all(Array.from({ length: 5 }, () => sichereKonto(opt(g.holen))));
    expect(g.aufrufe.length).toBe(1);
    expect(alle.filter((x) => x.art === 'angelegt').length).toBe(1);
    expect(alle.filter((x) => x.art === 'vorhanden').length).toBe(4);
  });

  it('eine frische Sperre eines anderen Prozesses: warten, NIE selbst anlegen', async () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(sperre(), 'fremd');
    const g = gegenstelle();
    let uhr = 1_000_000;
    // Die Sperre ist frisch (mtime = jetzt); die falsche Uhr springt in 100-ms-Schritten.
    const e = await sichereKonto(opt(g.holen, {
      fristMs: 500,
      jetzt: () => uhr,
      schlafen: async (ms) => { uhr += ms; },
    }));

    expect(e).toEqual({ art: 'gescheitert', grund: 'sperre-belegt' });
    expect(g.aufrufe.length).toBe(0);
  });

  it('eine Sperre, die von einem abgestuerzten Prozess stammt, wird uebernommen', async () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(sperre(), 'abgestuerzt');
    const alt = new Date(Date.now() - SPERRE_VERALTET_MS - 5000);
    utimesSync(sperre(), alt, alt);
    const g = gegenstelle();
    const e = await sichereKonto(opt(g.holen));

    expect(e.art).toBe('angelegt');
    expect(g.aufrufe.length).toBe(1);
  });

  it('der Wartende sieht den Schluessel, sobald der andere ihn schreibt', async () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(sperre(), 'fremd');
    let aufrufe = 0;
    const g = gegenstelle();
    const e = await sichereKonto(opt(g.holen, {
      schlafen: async () => {
        // Der "andere Prozess" wird fertig: Schluessel und Instanz da, Sperre frei.
        if (++aufrufe === 3) {
          writeFileSync(credentials(), JSON.stringify({ apiKey: SCHLUESSEL, instanceId: INSTANZ }));
          rmSync(sperre());
        }
      },
    }));
    expect(e).toEqual({ art: 'vorhanden', apiKey: SCHLUESSEL, instanzId: INSTANZ });
    expect(g.aufrufe.length).toBe(0);
  });
});

describe('sichereKonto: wenn es nicht klappt', () => {
  it('Gegenstelle lehnt ab: kein Konto, Sperre frei, Marke fuer die Abkuehlung', async () => {
    const g = gegenstelle({ status: 429 });
    const e = await sichereKonto(opt(g.holen));

    expect(e).toEqual({ art: 'gescheitert', grund: 'kein-test' });
    expect(existsSync(sperre())).toBe(false);
    expect(existsSync(credentials())).toBe(false);
    expect(existsSync(join(heim, '.cachly', 'anlegen.fehler'))).toBe(true);
  });

  it('Abkuehlung (Hook): nach einem Fehlschlag kein zweiter Versuch innerhalb von 10 Minuten', async () => {
    const schlecht = gegenstelle({ status: 500 });
    await sichereKonto(opt(schlecht.holen, { abkuehlungMs: 600_000 }));
    expect(schlecht.aufrufe.length).toBe(1);

    _sperreZuruecksetzen();
    const gut = gegenstelle();
    const e = await sichereKonto(opt(gut.holen, { abkuehlungMs: 600_000 }));
    expect(e).toEqual({ art: 'gescheitert', grund: 'abgekuehlt' });
    expect(gut.aufrufe.length).toBe(0);
  });

  it('der MCP-Server kennt keine Abkuehlung: er versucht es beim Werkzeugaufruf trotzdem', async () => {
    const schlecht = gegenstelle({ status: 500 });
    await sichereKonto(opt(schlecht.holen, { abkuehlungMs: 600_000 }));

    _sperreZuruecksetzen();
    const gut = gegenstelle();
    const e = await sichereKonto(opt(gut.holen));
    expect(e.art).toBe('angelegt');
    expect(gut.aufrufe.length).toBe(1);
  });

  it('Heimordner nicht beschreibbar: kein Konto, das nirgends gespeichert werden kann', async () => {
    // .cachly ist eine DATEI: der Ordner laesst sich nicht anlegen.
    writeFileSync(join(heim, '.cachly'), 'im Weg');
    const g = gegenstelle();
    const e = await sichereKonto(opt(g.holen));

    expect(e).toEqual({ art: 'gescheitert', grund: 'kein-schreibzugriff' });
    expect(g.aufrufe.length).toBe(0);
  });

  it('haengende Gegenstelle: endet an der Frist, nicht spaeter', async () => {
    const haengt = ((_url: string, init?: RequestInit) => new Promise((_ok, nein) => {
      init?.signal?.addEventListener('abort', () => nein(new Error('abgebrochen')));
    })) as unknown as typeof fetch;
    const start = Date.now();
    const e = await sichereKonto(opt(haengt, { fristMs: 700, anfrageMs: 700 }));

    expect(e.art).toBe('gescheitert');
    expect(Date.now() - start).toBeLessThan(2500);
    expect(existsSync(sperre())).toBe(false);
  });
});

describe('Auftrag fuer den Start-Import', () => {
  it('der Hook schreibt ihn, der Server nimmt ihn — und nur EINER bekommt ihn', () => {
    schreibeAuftrag({ instanzId: INSTANZ, projekt: '/p/repo' }, { home: heim });
    expect(auftragLiegt({ home: heim })).toBe(true);

    const erster = nimmAuftrag({ home: heim });
    const zweiter = nimmAuftrag({ home: heim });
    expect(erster?.instanzId).toBe(INSTANZ);
    expect(erster?.projekt).toBe('/p/repo');
    expect(zweiter).toBeNull();
    expect(auftragLiegt({ home: heim })).toBe(false);
  });

  it('ein Auftrag von gestern ist verfallen', () => {
    schreibeAuftrag({ instanzId: INSTANZ, projekt: '/p/repo' }, { home: heim });
    expect(nimmAuftrag({ home: heim }, Date.now() + AUFTRAG_VERFAELLT_MS + 60_000)).toBeNull();
    expect(auftragLiegt({ home: heim })).toBe(false);
  });

  it('ohne Auftrag: null, kein Fehler', () => {
    expect(nimmAuftrag({ home: heim })).toBeNull();
  });

  it('eine kaputte Datei ist kein Auftrag', () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(join(heim, '.cachly', 'startwissen-auftrag.json'), '{kaputt');
    expect(nimmAuftrag({ home: heim })).toBeNull();
  });
});

describe('Opt-out: CACHLY_STARTWISSEN', () => {
  it('false, 0, off, no, nein schalten das Startwissen ab; sonst ist es an', () => {
    for (const v of ['false', '0', 'off', 'no', 'nein', ' FALSE ']) {
      expect(startwissenEingeschaltet({ CACHLY_STARTWISSEN: v }), v).toBe(false);
    }
    for (const v of [undefined, '', 'true', '1']) {
      expect(startwissenEingeschaltet({ CACHLY_STARTWISSEN: v }), String(v)).toBe(true);
    }
  });
});
