/**
 * Runde 2 des Schwarms vom 03.11.2026, Bereich "ki" (04.11.2026):
 * was die KI aus den MCP-Werkzeugen sieht.
 *
 *   ki-03  fehlende Pflichtfelder: Klartext statt "Cannot read properties of undefined"
 *   ki-06  "Most likely fix" nur bei echter Uebereinstimmung
 *   ki-07  sehr lange Anfragen werden gekappt
 *   ki-08  ungueltiges outcome wird abgelehnt
 *   ki-10  brain_doctor-Texte englisch, kein Versprechen zu reparieren
 */
import { describe, it, expect } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import {
  ANFRAGE_MAX_ZEICHEN, fehlendePflichtfelder, kappeAnfrage, trefferIstStark, ungueltigerAusgang,
} from '../pflichtfelder.js';
import { TOOLS } from '../tools.js';
import { aussetzerEinzelheit, aussetzerErklaerung, SINNPFAD_ABBRUCH } from '../aussetzer.js';
import { beurteileSpeicher } from '../speicherlage.js';
import { formatiereBauabdruck } from '../bauabdruck.js';

const iid = '00000000-0000-4000-8000-000000000001';
const getConn = async (): Promise<never> => { throw new Error('getConn gerufen — die Pruefung kam zu spaet'); };
const noopApiFetch = async <T>(_p: string): Promise<T> => ({ data: [] } as unknown as T);

type Spec = { name: string; inputSchema?: Parameters<typeof fehlendePflichtfelder>[1] };
const spec = (n: string): Spec['inputSchema'] => (TOOLS as unknown as Spec[]).find((t) => t.name === n)?.inputSchema;

describe('ki-03: fehlende Pflichtfelder', () => {
  it.each([
    ['recall_best_solution', 'topic'],
    ['causal_trace', 'problem'],
    ['remember_context', 'key'],
    ['recall_context', 'key'],
    ['brain_predict', 'context'],
    ['brain_search', 'query'],
    ['forget_context', 'keys'],
    ['session_end', 'summary'],
  ])('%s ohne Felder nennt `%s`', (werkzeug, feld) => {
    const m = fehlendePflichtfelder(werkzeug, spec(werkzeug), { instance_id: iid });
    expect(m).toContain(`\`${feld}\` is missing`);
    expect(m).toContain('Nothing was done');
    expect(m).not.toContain('undefined');
  });

  it('instance_id zaehlt nie als fehlend', () => {
    expect(fehlendePflichtfelder('x', { required: ['instance_id'] }, {})).toBeNull();
  });

  it('vollstaendige Aufrufe gehen durch', () => {
    expect(fehlendePflichtfelder('recall_best_solution', spec('recall_best_solution'), { topic: 'a:b' })).toBeNull();
    expect(fehlendePflichtfelder('forget_context', spec('forget_context'), { keys: ['a'] })).toBeNull();
  });

  it('falsche Art: Text statt Liste und Zahl statt Text', () => {
    expect(fehlendePflichtfelder('forget_context', spec('forget_context'), { keys: 'a' })).toContain('must be a list');
    expect(fehlendePflichtfelder('recall_best_solution', spec('recall_best_solution'), { topic: 5 })).toContain('must be text');
  });
});

describe('ki-06: starke und schwache Treffer', () => {
  it('ein Wort von vier ist schwach', () => {
    expect(trefferIstStark(1, ['zebra', 'quantum', 'banana', 'nonsense', 'xyzzy'])).toBe(false);
  });
  it('zwei von drei und drei von zehn sind stark', () => {
    expect(trefferIstStark(2, ['a1x', 'b2x', 'c3x'])).toBe(true);
    expect(trefferIstStark(3, Array.from({ length: 10 }, (_, i) => `w${i}`))).toBe(true);
  });
  it('bei nur einem Frage-Wort reicht ein Treffer', () => {
    expect(trefferIstStark(1, ['deadlock'])).toBe(true);
    expect(trefferIstStark(0, ['deadlock'])).toBe(false);
  });
});

describe('ki-07: lange Anfragen', () => {
  it('60.000 Zeichen werden auf das Maximum gekappt', () => {
    expect(kappeAnfrage('abc '.repeat(15000)).length).toBe(ANFRAGE_MAX_ZEICHEN);
  });
  it('kurze Anfragen bleiben, Nicht-Text wird leer', () => {
    expect(kappeAnfrage('login loop')).toBe('login loop');
    expect(kappeAnfrage(undefined)).toBe('');
  });
});

describe('ki-08: ungueltiges outcome', () => {
  it('"banana" wird abgelehnt, bevor eine Verbindung gebraucht wird', async () => {
    const out = (await handleBrainTool('learn_from_attempts',
      { instance_id: iid, topic: 'ki:probe', outcome: 'banana', what_worked: 'ok' }, getConn, noopApiFetch))!;
    expect(out).toContain('`outcome` must be');
    expect(out).toContain('Nothing was stored');
  });
  it('die drei erlaubten Werte gehen durch', () => {
    for (const o of ['success', 'failure', 'partial']) expect(ungueltigerAusgang({ outcome: o })).toBeNull();
  });
  it('ein fehlendes outcome wird ebenfalls abgelehnt (vorher als "undefined" gespeichert)', () => {
    for (const o of [undefined, null, '']) expect(ungueltigerAusgang({ outcome: o })).toContain('needs `outcome`');
  });
});

describe('ki-10: brain_doctor-Texte', () => {
  it('die Gruende sind englisch erklaert, die Einzelheit kommt aus der Klammer', () => {
    expect(aussetzerErklaerung(SINNPFAD_ABBRUCH)).toMatch(/search by meaning failed/);
    expect(aussetzerErklaerung('unbekannt-xyz')).toBe('unbekannt-xyz');
    expect(aussetzerEinzelheit('der Bedeutungspfad brach ab (Cachly embed API error 400: {"error":"x"}) — diese Suche lief nur ueber Woerter'))
      .toBe('Cachly embed API error 400: {"error":"x"}');
    expect(aussetzerEinzelheit('ohne klammer')).toBe('');
  });
  it('Speicher- und Build-Zeilen enthalten kein Deutsch mehr', () => {
    const MB = 1024 * 1024;
    const texte = [
      ...beurteileSpeicher({ benutzt: 2 * MB, grenze: 200 * MB, richtlinie: 'volatile-lru' }),
      ...beurteileSpeicher({ benutzt: null, grenze: null, richtlinie: null }),
      ...beurteileSpeicher({ benutzt: 190 * MB, grenze: 200 * MB, richtlinie: 'allkeys-lru' }),
    ].map((u) => u.text).join('\n')
      + formatiereBauabdruck({ version: '1.0.0', commit: 'abc', gebautAm: '2026-01-01T00:00:00.000Z' }, new Date('2026-11-01T00:00:00Z'))
      + formatiereBauabdruck({ version: 'x', commit: 'x', gebautAm: 'unbekannt' });
    for (const wort of ['Raeumung', 'belegt', 'Bauabdruck', 'gebaut', 'unbekannt', 'laenger', 'loescht', 'Lektionen ohne Ablaufdatum sind sicher']) {
      expect(texte).not.toContain(wort);
    }
  });
});
