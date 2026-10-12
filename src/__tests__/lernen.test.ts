/**
 * Lernen aus Nutzung (lernen.ts): Kontrollgruppe, Bandit, Belohnung.
 *
 * Gegenproben (12.10.2026, je einzeln gefahren, danach per Kopie zurueckgesetzt):
 *   * promptEinblendung zeigt die Kontrollgruppe doch (`entscheidung.kontrolle
 *     ? '' :` entfernt) -> "Kontrollgruppe: berechnet, gemerkt, nicht gezeigt" rot.
 *   * Erkundungsdeckel entfernt (Thompson bei jedem Prompt) -> "ohne Daten
 *     fuehrt Arm 0, und hoechstens 10 %" rot.
 *   * Mindestzahl Bewertungen fuer Arm 0 ODER fuer den Herausforderer
 *     entfernt -> "drei Glueckstreffer kippen Arm 0 nicht" rot.
 *   * Kontrollanteil fest auf 5 % -> "20 % ergibt rund 20 %" und "0 schaltet ab" rot.
 *   * Zug-Kennung nicht geprueft (`&& s.zug === kennung` entfernt) ->
 *     "ein anderer Zug wird nicht bewertet" rot.
 *   * letzterZug liefert alle Zuege statt des letzten -> "Werkzeug-Ergebnisse
 *     und fruehere Zuege zaehlen nicht" rot.
 * Gegen origin/main ist die Datei rot, weil es lernen.ts dort nicht gibt.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ARME,
  BASIS_MIN_BELEGE,
  ERKUNDUNG_HOECHSTENS,
  OHNE_LERNEN,
  armePfad,
  belohnungMelden,
  bewerteZug,
  entscheide,
  fuehrenderArm,
  leseAnteil,
  leseArmZaehlung,
  lernEinstellungen,
  lernenAuffrischen,
  merkeEntscheidung,
  neuerSatz,
  offenPfad,
  posterior,
  sitzungsKennung,
  zaehlbaresThema,
  zieheBeta,
  zufallFuer,
  zufallsfolge,
  zugKennung,
  type ArmZaehlung,
  type Kandidat,
  type LernEinstellungen,
} from '../lernen.js';
import { letzterZug } from '../schreibbeleg.js';
import { bestandPfad, holeBestand, promptEinblendung, type EinblendLektion } from '../einblendung.js';

const AN: LernEinstellungen = { aktiv: true, kontrolleAnteil: 0.05, erkundung: 0.1 };
const INSTANZ = 'lernen-test-instanz';

/** n verschiedene Prompts derselben Sitzung — die Entscheidungen zaehlen. */
function zaehle(n: number, einstellungen: LernEinstellungen, zaehlung: ArmZaehlung[] | null = null) {
  const r = { kontrolle: 0, arme: [0, 0, 0], erkundet: 0 };
  for (let i = 0; i < n; i++) {
    const e = entscheide({ instanceId: INSTANZ, sitzung: 'sitzung-1', prompt: `Frage Nummer ${i} zum Deploy`, zaehlung, einstellungen });
    if (e.kontrolle) r.kontrolle++;
    else r.arme[e.arm]++;
    if (e.erkundet) r.erkundet++;
  }
  return r;
}

// ── Kontrollgruppe ───────────────────────────────────────────────────────────

describe('Kontrollgruppe', () => {
  it('Anteil: 5 % Vorgabe — gemessen ueber 20.000 Prompts zwischen 4,5 und 5,5 %', () => {
    const r = zaehle(20_000, AN);
    expect(r.kontrolle / 20_000).toBeGreaterThan(0.045);
    expect(r.kontrolle / 20_000).toBeLessThan(0.055);
  });

  it('Anteil folgt der Einstellung: 20 % ergibt rund 20 %', () => {
    const r = zaehle(10_000, { ...AN, kontrolleAnteil: 0.2 });
    expect(r.kontrolle / 10_000).toBeGreaterThan(0.18);
    expect(r.kontrolle / 10_000).toBeLessThan(0.22);
  });

  it('Determinismus: dieselbe Frage in derselben Sitzung faellt immer gleich', () => {
    for (let i = 0; i < 200; i++) {
      const a = { instanceId: INSTANZ, sitzung: 's', prompt: `Frage ${i}`, einstellungen: AN };
      expect(entscheide(a)).toEqual(entscheide(a));
      expect(zufallFuer(INSTANZ, 's', `Frage ${i}`)).toEqual(zufallFuer(INSTANZ, 's', `Frage ${i}`));
    }
  });

  it('Determinismus: andere Sitzung oder Instanz ergibt andere Zufallszahlen', () => {
    const a = zufallFuer(INSTANZ, 's1', 'Frage');
    expect(zufallFuer(INSTANZ, 's2', 'Frage').kontrolle).not.toBe(a.kontrolle);
    expect(zufallFuer('andere', 's1', 'Frage').kontrolle).not.toBe(a.kontrolle);
  });

  it('0 schaltet ab: kein einziger Prompt in der Kontrollgruppe', () => {
    expect(zaehle(20_000, { ...AN, kontrolleAnteil: 0 }).kontrolle).toBe(0);
    expect(lernEinstellungen({ CACHLY_KONTROLLE_ANTEIL: '0' }).kontrolleAnteil).toBe(0);
  });

  it('CACHLY_LERNEN=0 und CACHLY_NO_TELEMETRY=1 schalten alles ab — Arm 0, keine Kontrolle', () => {
    expect(lernEinstellungen({ CACHLY_LERNEN: '0' }).aktiv).toBe(false);
    expect(lernEinstellungen({ CACHLY_NO_TELEMETRY: '1' }).aktiv).toBe(false);
    expect(lernEinstellungen({}).aktiv).toBe(true);
    const aus = lernEinstellungen({ CACHLY_LERNEN: 'aus' });
    expect(entscheide({ instanceId: INSTANZ, sitzung: 's', prompt: 'x', einstellungen: aus })).toEqual(OHNE_LERNEN);
  });

  it('Umgebung: Bruch, Prozent und Deckel', () => {
    expect(leseAnteil('0.05', 0.05, 0.5)).toBe(0.05);
    expect(leseAnteil('5%', 0.05, 0.5)).toBe(0.05);
    expect(leseAnteil('5', 0.05, 0.5)).toBe(0.05);
    expect(leseAnteil('80', 0.05, 0.5)).toBe(0.5);
    expect(leseAnteil('Unsinn', 0.05, 0.5)).toBe(0.05);
    expect(leseAnteil('-1', 0.05, 0.5)).toBe(0.05);
    expect(lernEinstellungen({}).kontrolleAnteil).toBe(0.05);
    // Erkundung hoechstens 10 %, auch wenn die Umgebung mehr verlangt
    expect(lernEinstellungen({ CACHLY_ERKUNDUNG: '30%' }).erkundung).toBe(ERKUNDUNG_HOECHSTENS);
  });
});

// ── Bandit ───────────────────────────────────────────────────────────────────

describe('Bandit (Thompson mit Erkundungsdeckel)', () => {
  it('Arm 0 ist der heutige Stand: Tor 2, drei Lektionen', () => {
    expect(ARME[0]).toMatchObject({ minBelege: 2, topK: 3 });
    expect(BASIS_MIN_BELEGE).toBe(2);
  });

  it('ohne Daten fuehrt Arm 0, und hoechstens 10 % gehen an andere Arme', () => {
    expect(fuehrenderArm(posterior(null))).toBe(0);
    const r = zaehle(20_000, AN);
    const gezeigt = r.arme[0] + r.arme[1] + r.arme[2];
    expect(r.arme[0] / gezeigt).toBeGreaterThan(0.9);
    expect((r.arme[1] + r.arme[2]) / gezeigt).toBeLessThanOrEqual(0.1);
    // ... aber es wird wirklich erkundet
    expect(r.arme[1]).toBeGreaterThan(0);
    expect(r.arme[2]).toBeGreaterThan(0);
  });

  it('drei Glueckstreffer kippen Arm 0 nicht — unter 30 Bewertungen je Arm wird nicht umgelernt', () => {
    expect(fuehrenderArm(posterior([{ arm: 1, erfolge: 3, misserfolge: 0 }]))).toBe(0);
    // 10 von 15 gegen eine blosse Annahme fuer Arm 0: kein Wechsel
    expect(fuehrenderArm(posterior([{ arm: 2, erfolge: 10, misserfolge: 5 }]))).toBe(0);
    // Arm 2 mit 30 Bewertungen gegen ein UNGEMESSENES Arm 0: kein Wechsel
    expect(fuehrenderArm(posterior([{ arm: 2, erfolge: 20, misserfolge: 10 }]))).toBe(0);
    // Arm 0 gemessen, Arm 2 mit 29 Bewertungen: noch kein Wechsel; mit 30 schon
    const arm0 = { arm: 0, erfolge: 20, misserfolge: 80 };
    expect(fuehrenderArm(posterior([arm0, { arm: 2, erfolge: 20, misserfolge: 9 }]))).toBe(0);
    expect(fuehrenderArm(posterior([arm0, { arm: 2, erfolge: 20, misserfolge: 10 }]))).toBe(2);
  });

  it('lernt bei klaren Daten um: Arm 2 trifft 60 %, Arm 0 20 % -> Arm 2 fuehrt und bekommt ueber 90 %', () => {
    const daten: ArmZaehlung[] = [
      { arm: 0, erfolge: 100, misserfolge: 400 },
      { arm: 1, erfolge: 20, misserfolge: 80 },
      { arm: 2, erfolge: 300, misserfolge: 200 },
    ];
    expect(fuehrenderArm(posterior(daten))).toBe(2);
    const r = zaehle(10_000, AN, daten);
    const gezeigt = r.arme[0] + r.arme[1] + r.arme[2];
    expect(r.arme[2] / gezeigt).toBeGreaterThan(0.9);
  });

  it('lernt auch, wenn Arm 0 schlechter ist als sein Vorwissen', () => {
    const daten: ArmZaehlung[] = [
      { arm: 0, erfolge: 50, misserfolge: 450 },
      { arm: 1, erfolge: 60, misserfolge: 140 },
    ];
    expect(fuehrenderArm(posterior(daten))).toBe(1);
  });

  it('Erkundung 0: immer der fuehrende Arm', () => {
    const r = zaehle(5_000, { ...AN, erkundung: 0 });
    expect(r.arme[1] + r.arme[2]).toBe(0);
    expect(r.erkundet).toBe(0);
  });

  it('Beta-Ziehung trifft das Mittel, auch bei Form unter 1', () => {
    const z = zufallsfolge(42);
    let summe = 0;
    for (let i = 0; i < 5_000; i++) summe += zieheBeta({ a: 2, b: 8 }, z);
    expect(summe / 5_000).toBeGreaterThan(0.18);
    expect(summe / 5_000).toBeLessThan(0.22);
    let klein = 0;
    for (let i = 0; i < 5_000; i++) klein += zieheBeta({ a: 0.5, b: 0.5 }, z);
    expect(klein / 5_000).toBeGreaterThan(0.46);
    expect(klein / 5_000).toBeLessThan(0.54);
  });
});

// ── Belohnung ────────────────────────────────────────────────────────────────

const nutzer = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const antwort = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const aufruf = (name: string, input: unknown) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] } });
const ergebnis = (text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text }] }] } });

function kandidat(thema: string, gezeigt: boolean, rang = 0): Kandidat {
  return { thema, rang, punkte: 1, belege: 3, leser: null, gezeigt };
}

describe('Belohnung (bewerteZug)', () => {
  const kandidaten = [
    kandidat('betrieb:fail2ban-bannt-deploy-kanal', true, 0),
    kandidat('deploy:runner-ablauf', true, 1),
    kandidat('docker:layer-cache', false, 2),
  ];

  it('Thema im Antworttext -> 1, Bit des Kandidaten gesetzt', () => {
    const b = bewerteZug({ antwortText: 'Laut Lektion `betrieb:fail2ban-bannt-deploy-kanal` ist es fail2ban.', werkzeugEingaben: '' }, kandidaten);
    expect(b).toEqual({ belohnung: 1, benutzt: 0b001 });
  });

  it('Thema als Werkzeug-Eingabe (recall_best_solution) -> 1', () => {
    const zug = letzterZug([
      nutzer('Warum refused?'),
      aufruf('mcp__cachly__recall_best_solution', { topic: 'deploy:runner-ablauf' }),
      ergebnis('...'),
      antwort('Erledigt.'),
    ]);
    expect(bewerteZug(zug, kandidaten)).toEqual({ belohnung: 1, benutzt: 0b010 });
  });

  it('nicht aufgegriffen -> 0', () => {
    expect(bewerteZug({ antwortText: 'Ich schaue mir die Logs an.', werkzeugEingaben: '' }, kandidaten).belohnung).toBe(0);
  });

  it('nur ein NICHT gezeigter Kandidat aufgegriffen -> 0, aber sein Bit steht (Rangfolge-Daten)', () => {
    expect(bewerteZug({ antwortText: 'Siehe docker:layer-cache.', werkzeugEingaben: '' }, kandidaten)).toEqual({ belohnung: 0, benutzt: 0b100 });
  });

  it('Werkzeug-Ergebnisse und fruehere Zuege zaehlen nicht', () => {
    const zug = letzterZug([
      nutzer('Erste Frage'),
      antwort('Das war betrieb:fail2ban-bannt-deploy-kanal.'),
      nutzer('Zweite Frage'),
      aufruf('mcp__cachly__smart_recall', { query: 'deploy refused' }),
      ergebnis('Treffer: betrieb:fail2ban-bannt-deploy-kanal'),
      antwort('Ich pruefe die Firewall.'),
    ]);
    expect(zug.frage).toBe('Zweite Frage');
    expect(bewerteZug(zug, kandidaten).belohnung).toBe(0);
  });

  it('ohne zaehlbares Thema nicht bewertbar (-1); "docker" waere in jeder Antwort', () => {
    expect(zaehlbaresThema('docker')).toBe(false);
    expect(zaehlbaresThema('deploy:api')).toBe(true);
    expect(bewerteZug({ antwortText: 'docker', werkzeugEingaben: '' }, [kandidat('docker', true)]).belohnung).toBe(-1);
  });
});

// ── Merken und Melden ────────────────────────────────────────────────────────

describe('Merken und Melden', () => {
  let ordner: string;
  const alt = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const cfg = { apiUrl: 'http://fixture.invalid', jwt: 'test', instanceId: INSTANZ };

  beforeEach(() => {
    ordner = mkdtempSync(join(tmpdir(), 'cachly-lernen-test-'));
    process.env.TEMP = ordner;
    process.env.TMP = ordner;
    process.env.TMPDIR = ordner;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(alt)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(ordner, { recursive: true, force: true });
  });

  function satz(prompt: string, sitzung = 'sitz') {
    return neuerSatz({
      sitzung: sitzungsKennung(sitzung), zug: zugKennung(prompt), ereignis: 'UserPromptSubmit', editor: 'claude',
      arm: 0, kontrolle: false, erkundet: false, ausgewaehlt: 1, kandidatenZahl: 2, belege: 3, topScore: 1.2,
      leser: 'aus', leserMs: 0, quelle: 'platte', bestand: 10,
      kandidaten: [kandidat('betrieb:fail2ban-bannt-deploy-kanal', true, 0), kandidat('deploy:runner-ablauf', false, 1)],
    });
  }

  function netz(status = 200) {
    const koerper: unknown[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/einblendungen')) koerper.push(JSON.parse(String(init?.body)));
      return new Response('{}', { status });
    }) as typeof fetch;
    return { fetchFn, koerper };
  }

  const PROMPT = 'Warum meldet der Deploy connection refused?';
  const zeilen = [nutzer(PROMPT), antwort('Das ist betrieb:fail2ban-bannt-deploy-kanal — ignoreip setzen.')];

  it('Stop bewertet den Zug, meldet ohne Klartext-Thema und raeumt auf', async () => {
    merkeEntscheidung(INSTANZ, 'sitz', satz(PROMPT));
    const { fetchFn, koerper } = netz();
    const b = await belohnungMelden(cfg, 'sitz', zeilen, { fetchFn, einstellungen: AN });
    expect(b).toEqual({ belohnung: 1, benutzt: 0b01 });
    expect(koerper).toHaveLength(1);
    const text = JSON.stringify(koerper[0]);
    expect(text).not.toContain('fail2ban');
    expect(text).not.toContain('connection refused');
    const e = (koerper[0] as { entscheidungen: Record<string, unknown>[] }).entscheidungen[0];
    expect(e).toMatchObject({ belohnung: 1, benutzt: 1, arm: 0, kontrolle: false, ausgewaehlt: 1 });
    expect((e.merkmale as { t: string }[])[0].t).toMatch(/^[0-9a-f]{12}$/);
    expect(existsSync(offenPfad(INSTANZ, 'sitz'))).toBe(false);
  });

  it('ein anderer Zug wird nicht bewertet — die Entscheidung geht unbewertet mit', async () => {
    merkeEntscheidung(INSTANZ, 'sitz', satz('Eine ganz andere Frage zu Keycloak'));
    const { fetchFn, koerper } = netz();
    expect(await belohnungMelden(cfg, 'sitz', zeilen, { fetchFn, einstellungen: AN })).toBeNull();
    expect((koerper[0] as { entscheidungen: { belohnung: number }[] }).entscheidungen[0].belohnung).toBe(-1);
  });

  it('scheitert die Meldung, bleibt die Bewertung auf der Platte', async () => {
    merkeEntscheidung(INSTANZ, 'sitz', satz(PROMPT));
    const { fetchFn } = netz(503);
    await belohnungMelden(cfg, 'sitz', zeilen, { fetchFn, einstellungen: AN });
    const liegt = readFileSync(offenPfad(INSTANZ, 'sitz'), 'utf8');
    expect(JSON.parse(liegt.trim()).belohnung).toBe(1);
  });

  it('Lernen aus: nichts gemeldet', async () => {
    merkeEntscheidung(INSTANZ, 'sitz', satz(PROMPT));
    const { fetchFn, koerper } = netz();
    expect(await belohnungMelden(cfg, 'sitz', zeilen, { fetchFn, einstellungen: { ...AN, aktiv: false } })).toBeNull();
    expect(koerper).toHaveLength(0);
  });

  it('Nebenlauf holt die Zaehlungen je Arm und legt sie auf die Platte', async () => {
    const fetchFn = (async (url: string | URL) => {
      if (String(url).endsWith('/einblendung/arme')) {
        return new Response(JSON.stringify({ tage: 28, arme: [{ arm: 2, erfolge: 7, misserfolge: 3 }] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await lernenAuffrischen(cfg, { fetchFn, einstellungen: AN });
    expect(existsSync(armePfad(INSTANZ))).toBe(true);
    expect(leseArmZaehlung(INSTANZ)).toEqual([{ arm: 2, erfolge: 7, misserfolge: 3 }]);
    // verfallen nach sieben Tagen
    expect(leseArmZaehlung(INSTANZ, Date.now() + 8 * 24 * 3600 * 1000)).toBeNull();
  });

  it('SessionStart fragt nichts zusaetzlich — nur der Nebenlauf (lernen: true) holt Zaehlungen', async () => {
    const env = { CACHLY_LERNEN: process.env.CACHLY_LERNEN };
    process.env.CACHLY_LERNEN = '1';
    const gefragt: string[] = [];
    const fetchFn = (async (url: string | URL) => {
      gefragt.push(String(url).replace(/^.*\/api\/v1/, ''));
      if (String(url).endsWith('/export')) return new Response(JSON.stringify({ lessons: [] }), { status: 200 });
      return new Response(JSON.stringify({ arme: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await holeBestand(cfg, { force: true, fetchFn });
      expect(gefragt).toEqual([`/instances/${INSTANZ}/export`]);
      await holeBestand(cfg, { force: true, lernen: true, fetchFn });
      expect(gefragt).toContain('/einblendung/arme');
    } finally {
      if (env.CACHLY_LERNEN === undefined) delete process.env.CACHLY_LERNEN;
      else process.env.CACHLY_LERNEN = env.CACHLY_LERNEN;
    }
  });

  it('Nebenlauf meldet ruhende Sitzungen (kein Stop, z. B. Codex) unbewertet', async () => {
    merkeEntscheidung(INSTANZ, 'codex-sitzung', satz('Codex-Frage zum Deploy', 'codex-sitzung'));
    const { fetchFn, koerper } = netz();
    await lernenAuffrischen(cfg, { fetchFn, einstellungen: AN }); // frisch: bleibt liegen
    expect(koerper).toHaveLength(0);
    await lernenAuffrischen(cfg, { fetchFn, einstellungen: AN, jetzt: Date.now() + 31 * 60 * 1000 });
    expect(koerper).toHaveLength(1);
    expect(existsSync(offenPfad(INSTANZ, 'codex-sitzung'))).toBe(false);
  });

  // ── Der ganze Weg je Prompt (einblendung.ts) ──

  const BESTAND: EinblendLektion[] = [
    { topic: 'betrieb:fail2ban-bannt-deploy-kanal', what_worked: 'fail2ban auf node-1 bannte den Deploy-Kanal; connection refused trotz WireGuard. ignoreip setzen.', recall_count: 2 },
    { topic: 'deploy:runner-ablauf', what_worked: 'Der Deploy auf node-1 laeuft ueber den Runner; connection Fehler im Log pruefen.', recall_count: 9 },
  ];
  const bestandNetz = (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith('/export')) return new Response(JSON.stringify({ lessons: BESTAND }), { status: 200 });
    return new Response('{}', { status: 503 }); // Leser aus, Arme unbekannt
  }) as typeof fetch;

  /** Ein Prompt-Zusatz, der fuer diese Sitzung in (oder ausser) der Kontrollgruppe liegt. */
  function promptMit(kontrolle: boolean, cfgId: string, sitzung: string): string {
    for (let i = 0; i < 1000; i++) {
      const p = `Warum meldet der Deploy auf node-1 connection refused? (${i})`;
      const z = zufallFuer(cfgId, sitzung, p);
      if (kontrolle ? z.kontrolle < 0.05 : z.kontrolle >= 0.05 && z.erkundung >= 0.1) return p;
    }
    throw new Error('kein passender Prompt');
  }

  it('Kontrollgruppe: berechnet, gemerkt, nicht gezeigt — ausserhalb wird gezeigt wie vorher', async () => {
    const env = { CACHLY_LERNEN: process.env.CACHLY_LERNEN };
    process.env.CACHLY_LERNEN = '1';
    const c = { apiUrl: 'http://fixture.invalid', jwt: 'test', instanceId: `${INSTANZ}-weg` };
    try {
      const pK = promptMit(true, c.instanceId, 'weg');
      const k = await promptEinblendung(pK, c, { session: 'weg', protokoll: false, fetchFn: bestandNetz });
      expect(k.entscheidung.kontrolle).toBe(true);
      expect(k.kontext).toBe('');
      expect(k.auswahl.lessons.length).toBeGreaterThan(0); // berechnet
      const gemerkt = readFileSync(offenPfad(c.instanceId, 'weg'), 'utf8').trim().split('\n').map((z) => JSON.parse(z));
      expect(gemerkt[0]).toMatchObject({ kontrolle: true, arm: 0, zug: zugKennung(pK) });
      expect(gemerkt[0].ausgewaehlt).toBeGreaterThan(0);

      const pG = promptMit(false, c.instanceId, 'weg');
      const g = await promptEinblendung(pG, c, { session: 'weg', protokoll: false, fetchFn: bestandNetz });
      expect(g.entscheidung).toMatchObject({ kontrolle: false, arm: 0 });
      expect(g.kontext).toContain('betrieb:fail2ban-bannt-deploy-kanal');
      // Arm 0 zeigt genau das, was ohne Lernen gezeigt wird
      const ohne = await promptEinblendung(pG, c, { session: 'weg', protokoll: false, lernen: false, fetchFn: bestandNetz });
      expect(g.kontext).toBe(ohne.kontext);

      // vor einem Edit (PreToolUse) wird nicht gelernt
      const vorEdit = await promptEinblendung(pK, c, { session: 'weg', protokoll: false, ereignis: 'PreToolUse', fetchFn: bestandNetz });
      expect(vorEdit.entscheidung.aktiv).toBe(false);
      expect(vorEdit.kontext).not.toBe('');
    } finally {
      if (env.CACHLY_LERNEN === undefined) delete process.env.CACHLY_LERNEN;
      else process.env.CACHLY_LERNEN = env.CACHLY_LERNEN;
      rmSync(bestandPfad(c.instanceId), { force: true });
    }
  });

  it('Lernen aus (Testumgebung): nichts gemerkt', async () => {
    const c = { apiUrl: 'http://fixture.invalid', jwt: 'test', instanceId: `${INSTANZ}-aus` };
    const r = await promptEinblendung('Warum meldet der Deploy auf node-1 connection refused?', c, { session: 'aus', protokoll: false, fetchFn: bestandNetz });
    expect(r.entscheidung.aktiv).toBe(false);
    expect(existsSync(offenPfad(c.instanceId, 'aus'))).toBe(false);
    rmSync(bestandPfad(c.instanceId), { force: true });
  });

  it('kaputte Sitzungsdatei bricht nichts', async () => {
    merkeEntscheidung(INSTANZ, 'kaputt', satz(PROMPT, 'kaputt'));
    writeFileSync(offenPfad(INSTANZ, 'kaputt'), '{kaputt\n' + readFileSync(offenPfad(INSTANZ, 'kaputt'), 'utf8'));
    const { fetchFn, koerper } = netz();
    expect(await belohnungMelden(cfg, 'kaputt', zeilen, { fetchFn, einstellungen: AN })).toEqual({ belohnung: 1, benutzt: 1 });
    expect((koerper[0] as { entscheidungen: unknown[] }).entscheidungen).toHaveLength(1);
  });
});
