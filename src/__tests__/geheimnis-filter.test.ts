/**
 * Geheimnis-Filter: Werte werden geschwaerzt, Verweise und Platzhalter bleiben.
 *
 * Die Faelle stehen in api/internal/geheimnis/testdata/faelle.json und gelten
 * fuer Go UND TypeScript — eine Liste, zwei Umsetzungen, beide gepruefte.
 * `{X*n}` wird zu n-mal X: so steht kein echt aussehender Schluessel im Repo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schwaerze, schwaerzeFelder, GESCHWAERZT } from '../geheimnis-filter.js';

const DATEI = resolve(__dirname, '..', '..', '..', '..', 'api', 'internal', 'geheimnis', 'testdata', 'faelle.json');
const F = JSON.parse(readFileSync(DATEI, 'utf8')) as {
  schwaerzen: Array<{ art: string; text: string; wert: string }>;
  stehen_lassen: string[];
};
const expandiere = (s: string) => s.replace(/\{(.)\*(\d+)\}/g, (_, c: string, n: string) => c.repeat(Number(n)));
const x = (n: number, c = 'a') => c.repeat(n);

describe('schwaerze — echte Werte (gemeinsame Faelle)', () => {
  it.each(F.schwaerzen.map((c) => [c.art, expandiere(c.text), expandiere(c.wert)]))('%s', (art, text, wert) => {
    const s = schwaerze(text);
    expect(s.funde).toContain(art);
    expect(s.text).toContain(GESCHWAERZT);
    expect(s.text).not.toContain(wert);
    expect(s.funde.join()).not.toContain(wert);
  });

  it('der Rest der Zeile bleibt lesbar', () => {
    expect(schwaerze(`Authorization: Bearer ${x(32, 'T')} an /api/v1`).text).toBe(
      `Authorization: Bearer ${GESCHWAERZT} an /api/v1`,
    );
  });

  it('ein Wert wird nur einmal gezaehlt, auch wenn zwei Muster passen', () => {
    expect(schwaerze(`https://x:${'ghp_' + x(36, 'Q')}@github.com`).funde).toEqual(['GitHub-Token']);
  });
});

describe('schwaerze — bleibt stehen (Fehlalarme aus dem eigenen Bestand)', () => {
  it.each(F.stehen_lassen)('%s', (text) => {
    const s = schwaerze(text);
    expect(s.funde).toEqual([]);
    expect(s.text).toBe(text);
  });
});

describe('schwaerzeFelder', () => {
  it('schwaerzt Text- und Listenfelder und nennt das Feld, nie den Wert', () => {
    const wert = 'AKIA' + x(16, 'B');
    const r = schwaerzeFelder({ what_worked: `key ${wert}`, commands: ['ls', `aws ${wert}`], severity: 'major', n: 3 });
    expect(r.felder.what_worked).not.toContain(wert);
    expect(r.felder.commands[1]).not.toContain(wert);
    expect(r.felder.commands[0]).toBe('ls');
    expect(r.felder.n).toBe(3);
    expect(r.funde).toEqual(['what_worked: AWS-Zugangsschluessel', 'commands: AWS-Zugangsschluessel']);
    expect(r.funde.join()).not.toContain(wert);
  });
});
