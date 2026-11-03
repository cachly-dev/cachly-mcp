/**
 * Fehlende Pflichtfelder bekommen eine klare Ablehnung, keinen rohen Fehler
 * und keinen Datenmuell.
 *
 * Anlass (Schwarm 03.11.2026, nachgestellt gegen 0.10.225):
 *   - smart_recall ohne query: "Cannot read properties of undefined (reading 'split')".
 *   - smart_recall mit query="": "there is no lesson for this question yet" —
 *     die KI liest daraus ein leeres Brain.
 *   - learn_from_attempts ohne what_worked: gespeichert als "What worked: undefined".
 *   - learn_from_attempts mit topic="": eine Lektion unter dem Thema ``.
 *
 * Die Ablehnung kommt, bevor eine Verbindung gebraucht wird — deshalb wirft
 * getConn hier: wird es doch gerufen, ist die Pruefung zu spaet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleBrainTool } from '../handlers/brain.js';
import { fehlendeLernfelder, hatFrage } from '../pflichtfelder.js';

const iid = '00000000-0000-4000-8000-000000000001';
const getConn = async (): Promise<never> => { throw new Error('getConn gerufen — die Pruefung kam zu spaet'); };
const noopApiFetch = async <T>(_p: string): Promise<T> => ({ data: [] } as unknown as T);

describe('smart_recall ohne Frage', () => {
  it.each([[{}], [{ query: '' }], [{ query: '   ' }], [{ query: 42 }]])('lehnt %j klar ab', async (extra) => {
    const out = (await handleBrainTool('smart_recall', { instance_id: iid, ...extra }, getConn, noopApiFetch))!;
    expect(out).toContain('smart_recall needs `query`');
    expect(out).not.toContain('no lesson for this question');
  });

  it('eine echte Frage geht durch', () => {
    expect(hatFrage('login redirect loop')).toBe(true);
  });
});

describe('learn_from_attempts ohne Pflichtfelder', () => {
  it('ohne what_worked und ohne what_failed: abgelehnt, nichts gespeichert', async () => {
    const out = (await handleBrainTool('learn_from_attempts', { instance_id: iid, topic: 'probe:leer', outcome: 'success' }, getConn, noopApiFetch))!;
    expect(out).toContain('Nothing was stored');
    expect(out).toContain('what_worked');
  });

  it('leeres Thema: abgelehnt, kein "already exists"', async () => {
    const out = (await handleBrainTool('learn_from_attempts', { instance_id: iid, topic: '', outcome: 'success', what_worked: 'x' }, getConn, noopApiFetch))!;
    expect(out).toContain('needs `topic`');
    expect(out).not.toContain('already exists');
  });

  it('ein Fehlschlag mit what_failed und leerem what_worked bleibt erlaubt', () => {
    expect(fehlendeLernfelder({ topic: 'fix:auth', outcome: 'failure', what_worked: '', what_failed: 'clock skew broke JWT validation' })).toEqual([]);
    expect(fehlendeLernfelder({ topic: 'fix:auth', outcome: 'success', what_worked: 'use NTP' })).toEqual([]);
  });

  it('die Werkzeugbeschreibung nennt dieselben Pflichtfelder', () => {
    const tools = readFileSync(resolve(__dirname, '..', 'tools.ts'), 'utf8');
    const ab = tools.indexOf("name: 'learn_from_attempts'");
    expect(tools.slice(ab, tools.indexOf("name: '", ab + 10))).toContain("required: ['topic', 'outcome', 'what_worked']");
  });
});
