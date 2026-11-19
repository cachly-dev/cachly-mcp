import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anmeldungPfad,
  ladeLaufendeAnmeldung,
  merkeAnmeldung,
  MINDEST_RESTZEIT_MS,
  vergissAnmeldung,
  type GemerkteAnmeldung,
} from '../laufende-anmeldung.js';

const API = 'https://api.cachly.dev';
const JETZT = 1_800_000_000_000;

function anmeldung(teil: Partial<GemerkteAnmeldung> = {}): GemerkteAnmeldung {
  return {
    deviceCode: 'geraet-1',
    userCode: 'ABCD-EFGH',
    verifyUrl: 'https://cachly.dev/device?code=ABCD-EFGH',
    pollInterval: 5000,
    deadline: JETZT + 25 * 60_000,
    apiUrl: API,
    ...teil,
  };
}

describe('laufende Geraete-Anmeldung ueberlebt den Prozess', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cachly-anmeldung-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('gibt denselben Code an den naechsten Prozess weiter', () => {
    merkeAnmeldung(anmeldung(), { home });
    const zweiter = ladeLaufendeAnmeldung(API, { home, jetzt: JETZT + 60_000 });
    expect(zweiter?.userCode).toBe('ABCD-EFGH');
    expect(zweiter?.deviceCode).toBe('geraet-1');
  });

  it('ohne Datei gibt es nichts weiterzugeben', () => {
    expect(ladeLaufendeAnmeldung(API, { home, jetzt: JETZT })).toBeNull();
  });

  it('ein Code kurz vor Ablauf wird nicht mehr weitergegeben und entfernt', () => {
    merkeAnmeldung(anmeldung({ deadline: JETZT + MINDEST_RESTZEIT_MS - 1 }), { home });
    expect(ladeLaufendeAnmeldung(API, { home, jetzt: JETZT })).toBeNull();
    expect(existsSync(anmeldungPfad({ home }))).toBe(false);
  });

  it('ein Code einer anderen API zaehlt nicht, bleibt aber liegen', () => {
    merkeAnmeldung(anmeldung({ apiUrl: 'http://localhost:3001' }), { home });
    expect(ladeLaufendeAnmeldung(API, { home, jetzt: JETZT })).toBeNull();
    expect(existsSync(anmeldungPfad({ home }))).toBe(true);
  });

  it('eine kaputte Datei wird entfernt statt geglaubt', () => {
    mkdirSync(join(home, '.cachly'), { recursive: true });
    writeFileSync(anmeldungPfad({ home }), '{"deviceCode": 1', 'utf8');
    expect(ladeLaufendeAnmeldung(API, { home, jetzt: JETZT })).toBeNull();
    expect(existsSync(anmeldungPfad({ home }))).toBe(false);
  });

  it('eine Datei ohne Pflichtfelder wird entfernt', () => {
    mkdirSync(join(home, '.cachly'), { recursive: true });
    writeFileSync(anmeldungPfad({ home }), JSON.stringify({ deviceCode: 'x', apiUrl: API }), 'utf8');
    expect(ladeLaufendeAnmeldung(API, { home, jetzt: JETZT })).toBeNull();
    expect(existsSync(anmeldungPfad({ home }))).toBe(false);
  });

  it('vergessen trifft nur den eigenen Code, nie einen neueren', () => {
    merkeAnmeldung(anmeldung({ deviceCode: 'neuer-code' }), { home });
    vergissAnmeldung('alter-code', { home });
    expect(existsSync(anmeldungPfad({ home }))).toBe(true);
    vergissAnmeldung('neuer-code', { home });
    expect(existsSync(anmeldungPfad({ home }))).toBe(false);
  });

  it('vergessen ohne Datei wirft nicht', () => {
    expect(() => vergissAnmeldung('egal', { home })).not.toThrow();
  });
});
