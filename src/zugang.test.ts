import { describe, it, expect, beforeEach } from 'vitest';
import { sichereZugang, sofortTestHinweis, echterWert, istInstanzKennung, _zugangZuruecksetzen, type ZugangsAufruf } from './zugang.js';
import type { SofortTest } from './sofort-test.js';

/*
 * Befund 11.10.2026: Ohne Schluessel startete JEDER Werkzeugaufruf die
 * Browser-Anmeldung. Von 8 solchen Starts kam 1 durch; ueber das
 * Claude-Code-Plugin entstand seit dem 28.08. kein Konto. Der Sofort-Test
 * war eingebaut, aber hinter der Anmeldung unerreichbar.
 *
 * Diese Tests halten die Reihenfolge fest: erst Sofort-Test, dann Anmeldung.
 * Der Prozess-Test (sofort-test-prozess.test.ts) prueft dasselbe am echten
 * Server.
 */

const TEST: SofortTest = { apiKey: 'cky_trial_abc', instanzId: 'inst-1', tarifEndetAm: '2026-10-25T12:00:00Z' };

function aufbau(ueber: Partial<ZugangsAufruf> & { test?: SofortTest | null } = {}) {
  const spur: string[] = [];
  let schluesselImProzess = ueber.schluessel ?? '';
  const ablagen = {
    prozess: '',
    einbettung: '',
    credentials: '',
    editorConfig: '',
    instanz: '',
    instanzConfig: '',
  };
  const ereignisse: Array<{ event: string; extra?: Record<string, unknown> }> = [];
  let sofortTestRufe = 0;
  const { test: testWert, ...rest } = ueber;
  const test = 'test' in ueber ? testWert : TEST;

  const aufruf: ZugangsAufruf = {
    schluessel: schluesselImProzess,
    konfigurierteInstanz: '',
    werkzeugName: 'smart_recall',
    holeSofortTest: async () => { sofortTestRufe++; spur.push('sofort-test'); return test ?? null; },
    ablagen: {
      setzeSchluessel: (k) => { schluesselImProzess = k; ablagen.prozess = k; },
      setEmbedJwt: (k) => { ablagen.einbettung = k; },
      saveApiKey: (k) => { ablagen.credentials = k; },
      persistApiKeyToConfig: async (k) => { ablagen.editorConfig = k; },
      merkeInstanz: (id) => { ablagen.instanz = id; },
      persistInstanceIdToConfig: async (id) => { ablagen.instanzConfig = id; },
    },
    meldeEreignis: (event, extra) => { ereignisse.push({ event, extra }); },
    werkzeug: async () => {
      spur.push(`werkzeug(schluessel=${schluesselImProzess || 'leer'})`);
      return 'ERGEBNIS';
    },
    anmelden: async () => { spur.push('anmelden'); return 'BITTE ANMELDEN'; },
    protokoll: () => {},
    ...rest,
  };
  return { aufruf, spur, ablagen, ereignisse, rufe: () => sofortTestRufe };
}

describe('sichereZugang: ohne Schluessel erst der Sofort-Test, dann die Anmeldung', () => {
  beforeEach(() => _zugangZuruecksetzen());

  // (a) Der Kernfall des Befunds.
  it('ohne Schluessel, Sofort-Test gelingt: keine Anmeldung, Schluessel in allen Ablagen, Werkzeug laeuft', async () => {
    const { aufruf, spur, ablagen, ereignisse } = aufbau();
    const antwort = await sichereZugang(aufruf);

    expect(spur).toEqual(['sofort-test', 'werkzeug(schluessel=cky_trial_abc)']);
    expect(spur).not.toContain('anmelden');

    // Dieselben Ablagen wie nach der Browser-Anmeldung. Fehlt eine, ist der
    // Schluessel nach dem Neustart weg (Editor-Config), die Hooks finden ihn
    // nicht (credentials.json) oder die Einbettungen laufen ohne ihn.
    expect(ablagen).toEqual({
      prozess: 'cky_trial_abc',
      einbettung: 'cky_trial_abc',
      credentials: 'cky_trial_abc',
      editorConfig: 'cky_trial_abc',
      instanz: 'inst-1',
      instanzConfig: 'inst-1',
    });

    expect(ereignisse).toEqual([{ event: 'instant_trial_started', extra: { tool: 'smart_recall', instance_id: 'inst-1' } }]);

    // Das echte Ergebnis zuerst, der Hinweis genau einmal dahinter.
    expect(antwort.startsWith('ERGEBNIS')).toBe(true);
    expect(antwort.match(/test Brain was created/g)?.length).toBe(1);
    expect(antwort).toContain('EU servers');
    expect(antwort).toContain('npx @cachly-dev/mcp-server@latest autopilot');
  });

  // (b) Rueckfall unveraendert.
  it('Sofort-Test scheitert: die Browser-Anmeldung startet wie bisher', async () => {
    const { aufruf, spur, ablagen, ereignisse } = aufbau({ test: null });
    const antwort = await sichereZugang(aufruf);

    expect(spur).toEqual(['sofort-test', 'anmelden']);
    expect(antwort).toBe('BITTE ANMELDEN');
    expect(ablagen.prozess).toBe('');
    expect(ablagen.credentials).toBe('');
    expect(ereignisse).toEqual([]);
  });

  // (c) Ein zweites Konto waere schlimmer als eine Fehlermeldung.
  it('vorhandener, aber falscher Schluessel: KEIN Sofort-Test, das Werkzeug laeuft mit diesem Schluessel', async () => {
    const { aufruf, spur, ablagen, rufe } = aufbau({ schluessel: 'cky_live_abgelaufen' });
    const antwort = await sichereZugang(aufruf);

    expect(rufe()).toBe(0);
    expect(spur).toEqual(['werkzeug(schluessel=cky_live_abgelaufen)']);
    expect(ablagen.credentials).toBe('');
    expect(antwort).toBe('ERGEBNIS');
  });

  // (d) Wer auf ein bestehendes Brain zeigt, hat ein Konto. Er braucht die
  // Anmeldung, kein zweites Brain neben dem eigenen.
  it('konfigurierte Instanz (UUID) ohne Schluessel: Anmeldung statt Sofort-Test', async () => {
    const { aufruf, spur, rufe } = aufbau({ konfigurierteInstanz: '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0' });
    await sichereZugang(aufruf);
    expect(rufe()).toBe(0);
    expect(spur).toEqual(['anmelden']);
  });

  it('gueltige UUID als instance_id im Aufruf ohne Schluessel: Anmeldung wie bisher', async () => {
    const { aufruf, spur, rufe } = aufbau({ aufrufInstanz: '9D4077AA-BFA2-468B-89CD-0A8D8F3EC483' });
    await sichereZugang(aufruf);
    expect(rufe()).toBe(0);
    expect(spur).toEqual(['anmelden']);
  });

  // Modelle erfinden instance_ids oder schreiben sie aus einem fremden
  // CLAUDE.md ab. Ein neuer Nutzer darf deshalb NICHT in der Anmeldung landen.
  it('instance_id "default" im Aufruf: Sofort-Test, keine Anmeldung', async () => {
    const { aufruf, spur, rufe } = aufbau({ aufrufInstanz: 'default' });
    await sichereZugang(aufruf);
    expect(rufe()).toBe(1);
    expect(spur).toEqual(['sofort-test', 'werkzeug(schluessel=cky_trial_abc)']);
  });

  it('erfundene Werte im Aufruf oder in der Env zaehlen nicht als Instanz', async () => {
    for (const [konfig, aufrufWert] of [['my-brain', undefined], ['', 'my-brain'], ['', '8e03addd-a2d9-406e'], ['', 42]] as const) {
      _zugangZuruecksetzen();
      const { aufruf, spur } = aufbau({ konfigurierteInstanz: konfig, aufrufInstanz: aufrufWert });
      await sichereZugang(aufruf);
      expect(spur[0], `konfig=${konfig} aufruf=${String(aufrufWert)}`).toBe('sofort-test');
      expect(spur).not.toContain('anmelden');
    }
  });

  // Das Plugin setzt "${user_config.instance_id}". Bleibt das Feld leer, darf
  // der Platzhalter NICHT als "zeigt auf ein Brain" gelten — sonst waere der
  // Sofort-Test fuer Plugin-Nutzer wieder unerreichbar.
  it('ein nicht ersetzter Platzhalter zaehlt nicht als Instanz', async () => {
    const { aufruf, spur } = aufbau({ konfigurierteInstanz: '${user_config.instance_id}' });
    await sichereZugang(aufruf);
    expect(spur[0]).toBe('sofort-test');
    expect(spur).not.toContain('anmelden');
  });

  // Zwei gleichzeitige erste Aufrufe: holeSofortTest liefert beim zweiten Mal
  // null (einmal je Prozess). Ohne gemeinsamen Versuch startete der zweite
  // Aufruf eine Browser-Anmeldung, obwohl der erste gerade einen Zugang holt.
  it('zwei gleichzeitige Aufrufe teilen sich EINEN Sofort-Test, keiner meldet an', async () => {
    let schluessel = '';
    let rufe = 0;
    let abgelegt = 0;
    const spur: string[] = [];
    const basis = (): ZugangsAufruf => ({
      schluessel: '',
      konfigurierteInstanz: '',
      werkzeugName: 'smart_recall',
      holeSofortTest: async () => { rufe++; await new Promise((r) => setTimeout(r, 5)); return TEST; },
      ablagen: {
        setzeSchluessel: (k) => { schluessel = k; abgelegt++; },
        setEmbedJwt: () => {},
        saveApiKey: () => {},
        persistApiKeyToConfig: async () => {},
        merkeInstanz: () => {},
        persistInstanceIdToConfig: async () => {},
      },
      meldeEreignis: () => {},
      werkzeug: async () => { spur.push(`werkzeug(${schluessel || 'leer'})`); return 'OK'; },
      anmelden: async () => { spur.push('anmelden'); return 'ANMELDEN'; },
      protokoll: () => {},
    });
    const [eins, zwei] = await Promise.all([sichereZugang(basis()), sichereZugang(basis())]);

    expect(rufe).toBe(1);
    expect(abgelegt).toBe(1);
    expect(spur).not.toContain('anmelden');
    expect(spur).toEqual(['werkzeug(cky_trial_abc)', 'werkzeug(cky_trial_abc)']);
    // Der Hinweis steht nur am Aufruf, der den Zugang geholt hat.
    expect([eins, zwei].filter((a) => a.includes('test Brain was created')).length).toBe(1);
  });
});

describe('sofortTestHinweis', () => {
  it('nennt das Datum, an dem der Dev-Tarif endet, wenn es bekannt ist', () => {
    expect(sofortTestHinweis(TEST)).toContain('Dev tier until 2026-10-25');
  });

  it('ohne Datum: 14 Tage, wie die Gegenstelle sie vergibt', () => {
    expect(sofortTestHinweis({ apiKey: 'k', instanzId: 'i' })).toContain('14 days of Dev tier');
  });

  // Es gibt keinen Weg, ein Test-Brain auf ein Konto zu uebertragen. Der
  // Hinweis darf das nicht versprechen.
  it('verspricht keine Uebernahme der Test-Daten', () => {
    expect(sofortTestHinweis(TEST)).toContain('do not move over yet');
  });
});

describe('echterWert', () => {
  it('leer, Platzhalter und Nicht-Text zaehlen als nichts', () => {
    for (const w of [undefined, null, '', '   ', '${user_config.instance_id}', 42]) expect(echterWert(w)).toBe('');
  });
  it('eine echte Kennung bleibt', () => {
    expect(echterWert(' 8e03addd-a2d9-406e-bcbb-d6d8c938a3d0 ')).toBe('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0');
  });
});

describe('istInstanzKennung', () => {
  it('nur UUID-Form zaehlt, Gross- und Kleinschreibung egal', () => {
    expect(istInstanzKennung('8e03addd-a2d9-406e-bcbb-d6d8c938a3d0')).toBe(true);
    expect(istInstanzKennung('8E03ADDD-A2D9-406E-BCBB-D6D8C938A3D0')).toBe(true);
    for (const w of ['default', 'my-brain', '', '${user_config.instance_id}', '8e03addd-a2d9-406e-bcbb', undefined, 7]) {
      expect(istInstanzKennung(w)).toBe(false);
    }
  });
});
