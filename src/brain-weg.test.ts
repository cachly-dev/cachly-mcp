import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  istSofortTestSchluessel, leseAutoAntwort, legeEinmalAn, nimmHinweisEinmal, hinweisErsetzt,
  meldungRegistriert, meldungAnlegenFehlt, ist404, istBekanntWeg, merkeWeg, ersetzeInstanceId, _brainWegZuruecksetzen,
} from './brain-weg.js';
import { markiereApiFehler } from './rolle.js';

/*
 * 28.11.2026: Der Abraeumer (api, PR #1264) loescht leere Sofort-Test-Brains nach
 * 14 Tagen. Schluessel und Konto bleiben. Die Bausteine hier sind die reine Logik;
 * der echte Server steht in __tests__/brain-weg-prozess.test.ts.
 */

beforeEach(() => _brainWegZuruecksetzen());

describe('Sofort-Test-Schluessel erkennen', () => {
  it('nur cky_trial_ ist ein Sofort-Test', () => {
    expect(istSofortTestSchluessel('cky_trial_abc')).toBe(true);
    expect(istSofortTestSchluessel('cky_live_abc')).toBe(false);
    expect(istSofortTestSchluessel('')).toBe(false);
  });
});

describe('Antwort von POST /instances/auto lesen', () => {
  it('neu angelegt: instance_id, created true', () => {
    expect(leseAutoAntwort({ instance_id: 'n1', status: 'provisioning', created: true })).toEqual({ id: 'n1', neu: true });
  });
  it('schon vorhanden: instance mit Namen, created false', () => {
    expect(leseAutoAntwort({ instance: { id: 'v1', name: 'Mein Brain' }, created: false })).toEqual({ id: 'v1', name: 'Mein Brain', neu: false });
  });
  it('ohne Kennung: null', () => {
    expect(leseAutoAntwort({})).toBeNull();
    expect(leseAutoAntwort(null)).toBeNull();
  });
});

describe('hoechstens ein Versuch je Prozess', () => {
  it('zwei Aufrufe, ein Netzaufruf, gleiches Ergebnis', async () => {
    let rufe = 0;
    const auto = async () => { rufe++; return { instance_id: 'n1', created: true }; };
    const [a, b] = await Promise.all([legeEinmalAn(auto), legeEinmalAn(auto)]);
    expect(rufe).toBe(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, id: 'n1', neu: true });
  });
  it('Fehlschlag wird gemerkt: kein zweiter Versuch', async () => {
    let rufe = 0;
    const kaputt = async () => { rufe++; throw markiereApiFehler(new Error('forbidden'), 403, {}); };
    const a = await legeEinmalAn(kaputt);
    const b = await legeEinmalAn(kaputt);
    expect(rufe).toBe(1);
    expect(a).toMatchObject({ ok: false, status: 403 });
    expect(b).toBe(a);
  });
  it('Netzfehler ohne Status wirft nie', async () => {
    const a = await legeEinmalAn(async () => { throw new Error('fetch failed'); });
    expect(a).toMatchObject({ ok: false, status: 0 });
  });
});

describe('Hinweis genau einmal', () => {
  it('erst true, dann false', () => {
    expect(nimmHinweisEinmal()).toBe(true);
    expect(nimmHinweisEinmal()).toBe(false);
  });
  it('verschwundene Kennungen werden gemerkt', () => {
    expect(istBekanntWeg('x')).toBe(false);
    merkeWeg('x');
    expect(istBekanntWeg('x')).toBe(true);
  });
});

describe('404 erkennen', () => {
  it('nur 404 der API', () => {
    expect(ist404(markiereApiFehler(new Error('x'), 404, {}))).toBe(true);
    expect(ist404(markiereApiFehler(new Error('x'), 401, {}))).toBe(false);
    expect(ist404(new Error('boom'))).toBe(false);
  });
});

describe('Texte', () => {
  it('Sofort-Test, neu angelegt: ehrlich, kurz, ohne Umgebungsvariable', () => {
    const t = hinweisErsetzt('old-id', { id: 'new-id', name: 'brain-7', neu: true }, 'datei');
    expect(t).toContain('Your trial Brain was removed because it stayed empty and unused for 14 days.');
    expect(t).toContain('cachly created a new, empty Brain for you ("brain-7" (new-id)).');
    expect(t).toContain('Nothing was lost: the old one had no saved lessons.');
    expect(t).not.toContain('CACHLY_BRAIN_INSTANCE_ID');
  });
  it('aus der Umgebung: sagt, was zu aendern ist', () => {
    const t = hinweisErsetzt('old-id', { id: 'new-id', neu: true }, 'umgebung');
    expect(t).toContain('CACHLY_BRAIN_INSTANCE_ID');
    expect(t).toContain('set it to new-id');
  });
  it('Konto hatte schon ein Brain: kein "created"', () => {
    const t = hinweisErsetzt('old-id', { id: 'v1', name: 'Mein Brain', neu: false }, 'datei');
    expect(t).not.toContain('created a new');
    expect(t).toContain('Mein Brain');
  });
  it('registrierter Schluessel: Weg zur Auswahl und zum Setup', () => {
    const t = meldungRegistriert('abc');
    expect(t).toContain('The Brain abc no longer exists in your account.');
    expect(t).toContain('https://cachly.dev/instances');
    expect(t).toContain('npx @cachly-dev/mcp-server@latest setup');
  });
  it('Anlegen scheitert: je Grund der naechste Schritt', () => {
    expect(meldungAnlegenFehlt('o', { status: 403, detail: '' })).toContain('Sign in once');
    expect(meldungAnlegenFehlt('o', { status: 400, detail: '' })).toContain('limit');
    expect(meldungAnlegenFehlt('o', { status: 0, detail: '' })).toContain('no answer from the API');
    expect(meldungAnlegenFehlt('o', { status: 500, detail: '' })).toContain('API answered 500');
  });
});

describe('credentials.json: nur ersetzen, wo die alte Kennung stand', () => {
  let heim = '';
  const datei = () => join(heim, '.cachly', 'credentials.json');
  const schreibe = (o: unknown) => { mkdirSync(join(heim, '.cachly'), { recursive: true }); writeFileSync(datei(), JSON.stringify(o)); };
  beforeEach(() => {
    heim = mkdtempSync(join(tmpdir(), 'cachly-weg-'));
    return () => rmSync(heim, { recursive: true, force: true });
  });

  it('alte Kennung und gleicher Schluessel: ersetzt', () => {
    schreibe({ apiKey: 'cky_trial_k', instanceId: 'alt' });
    expect(ersetzeInstanceId('alt', 'neu', { home: heim, apiKey: 'cky_trial_k' })).toBe(true);
    expect(JSON.parse(readFileSync(datei(), 'utf8'))).toEqual({ apiKey: 'cky_trial_k', instanceId: 'neu' });
  });
  it('andere Kennung in der Datei: unberuehrt', () => {
    schreibe({ apiKey: 'cky_trial_k', instanceId: 'andere' });
    const vorher = readFileSync(datei(), 'utf8');
    expect(ersetzeInstanceId('alt', 'neu', { home: heim, apiKey: 'cky_trial_k' })).toBe(false);
    expect(readFileSync(datei(), 'utf8')).toBe(vorher);
  });
  it('anderer Schluessel: unberuehrt', () => {
    schreibe({ apiKey: 'cky_live_x', instanceId: 'alt' });
    const vorher = readFileSync(datei(), 'utf8');
    expect(ersetzeInstanceId('alt', 'neu', { home: heim, apiKey: 'cky_trial_k' })).toBe(false);
    expect(readFileSync(datei(), 'utf8')).toBe(vorher);
  });
  it('keine Datei: nichts angelegt', () => {
    expect(ersetzeInstanceId('alt', 'neu', { home: heim, apiKey: 'k' })).toBe(false);
  });
});
