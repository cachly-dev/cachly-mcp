import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialsPath, istPlatzhalter, readInstanceId, resolveApiKey, saveApiKey, saveInstanceId } from './credentials.js';

/*
 * ── Die stille Variante des Fehlers, den das Plugin beheben soll ────────────
 *
 * Das Claude-Code-Plugin deklariert:
 *
 *     "CACHLY_JWT": "${user_config.api_key}"
 *
 * Setzt der Nutzer den Wert nie, kann bei uns der Text `${user_config.api_key}`
 * selbst ankommen. Er ist "wahr" — also hielte ihn jede Pruefung fuer einen
 * Schluessel. Folge: jede Anfrage 401, und die Selbsteinrichtung springt NICHT
 * an, weil scheinbar ein Schluessel da ist.
 *
 * Der Server liefe. Er koennte nur nichts. Und niemand saehe einen Fehler.
 */
describe('Ein nicht ersetzter Platzhalter ist kein Schluessel', () => {
  it('erkennt die Form ${...}', () => {
    expect(istPlatzhalter('${user_config.api_key}')).toBe(true);
    expect(istPlatzhalter('${user_config.instance_id}')).toBe(true);
    expect(istPlatzhalter('  ${irgendwas}  ')).toBe(true);
    expect(istPlatzhalter('${}')).toBe(true);
  });

  it('haelt einen echten Schluessel NICHT fuer einen Platzhalter', () => {
    // Der teure Fehler waere anders herum: einen gueltigen Schluessel
    // wegzuwerfen, weil das Muster zu gierig ist.
    for (const echt of [
      'cky_live_abc123',
      'cky_trial_abc123',
      'eyJhbGciOiJSUzI1NiJ9.abc.def',
      '${nicht am Ende',
      'text ${mittendrin} text',
      'a${b}',
    ]) {
      expect(istPlatzhalter(echt), echt).toBe(false);
    }
  });

  it('resolveApiKey uebergeht den Platzhalter und faellt weiter', () => {
    const key = resolveApiKey({
      env: { CACHLY_JWT: '${user_config.api_key}', CACHLY_API_KEY: 'cky_live_echt' },
      home: '/kein/pfad',
      cwd: '/kein/pfad',
    });
    expect(key).toBe('cky_live_echt');
  });

  it('nur Platzhalter heisst: KEIN Schluessel, nicht ein leerer', () => {
    // undefined statt '' ist der Unterschied, an dem die Selbsteinrichtung
    // haengt: sie springt bei `!JWT` an.
    const key = resolveApiKey({
      env: { CACHLY_JWT: '${user_config.api_key}' },
      home: '/kein/pfad',
      cwd: '/kein/pfad',
    });
    expect(key).toBeUndefined();
  });
});

/*
 * ── Die Instanz liegt neben dem Schluessel (11.10.2026) ────────────────────
 *
 * Die Hooks fanden den Schluessel in ~/.cachly/credentials.json, die Instanz
 * aber nur in ~/.claude/mcp.json. Wer cachly als Plugin installierte, hatte
 * nach dem Sofort-Test einen Schluessel und keine Instanz — die Einblendung
 * blieb still. Jetzt liegt beides in einer Datei. Die eine Gefahr dabei: eine
 * Instanz neben dem Schluessel eines ANDEREN Kontos.
 */
describe('Instanz neben dem Schluessel in ~/.cachly/credentials.json', () => {
  let heim: string;
  beforeEach(() => { heim = mkdtempSync(join(tmpdir(), 'cachly-cred-instanz-')); });
  afterEach(() => { rmSync(heim, { recursive: true, force: true }); });
  const datei = () => JSON.parse(readFileSync(credentialsPath({ home: heim }), 'utf8'));

  it('saveInstanceId legt die Instanz neben den passenden Schluessel', () => {
    saveApiKey('cky_a', { home: heim });
    saveInstanceId('inst-a', { home: heim, apiKey: 'cky_a' });
    expect(datei()).toEqual({ apiKey: 'cky_a', instanceId: 'inst-a' });
    expect(readInstanceId({ home: heim })).toBe('inst-a');
  });

  it('saveInstanceId schreibt NICHT neben den Schluessel eines anderen Kontos', () => {
    saveApiKey('cky_a', { home: heim });
    saveInstanceId('inst-b', { home: heim, apiKey: 'cky_b' });
    expect(datei()).toEqual({ apiKey: 'cky_a' });
    expect(readInstanceId({ home: heim })).toBeUndefined();
  });

  it('saveInstanceId ohne Datei schreibt nichts (kein Schluessel, keine Paarung)', () => {
    saveInstanceId('inst-a', { home: heim, apiKey: 'cky_a' });
    expect(existsSync(credentialsPath({ home: heim }))).toBe(false);
  });

  it('derselbe Schluessel noch einmal behaelt die Instanz; ein neuer Schluessel verwirft sie', () => {
    saveApiKey('cky_a', { home: heim });
    saveInstanceId('inst-a', { home: heim, apiKey: 'cky_a' });
    saveApiKey('cky_a', { home: heim });
    expect(readInstanceId({ home: heim })).toBe('inst-a');
    saveApiKey('cky_neu', { home: heim });
    expect(datei()).toEqual({ apiKey: 'cky_neu' });
  });

  it('BESTANDSSCHUTZ: eine alte Datei nur mit Schluessel funktioniert weiter', () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(credentialsPath({ home: heim }), JSON.stringify({ apiKey: 'cky_alt' }), 'utf8');
    expect(resolveApiKey({ env: {}, home: heim, cwd: '/kein/pfad' })).toBe('cky_alt');
    expect(readInstanceId({ home: heim })).toBeUndefined();
  });

  it('ein Platzhalter als Instanz zaehlt als nichts', () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(credentialsPath({ home: heim }), JSON.stringify({ apiKey: 'k', instanceId: '${user_config.instance_id}' }), 'utf8');
    expect(readInstanceId({ home: heim })).toBeUndefined();
  });
});
