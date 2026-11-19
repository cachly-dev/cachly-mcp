/**
 * Die beschleunigte Wortsuche muss dieselbe Rangliste liefern wie die
 * eingefrorene Fassung (helfer/wortsuche-alt.ts): gleiche Schluessel, gleiche
 * Reihenfolge, gleiche Punkte (auf 6 Stellen), gleiche Treffer-Woerter.
 * Eine "bessere" Rangfolge ist hier ein Fehler — die Bench-Untergrenzen
 * haengen an ihr.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  bestandAusDokumenten, keywordSearchMitBestand, levenshtein, levenshteinHoechstens2,
  type Wortbestand,
} from '../search.js';
import { keywordSearchMitBestandAlt } from './helfer/wortsuche-alt.js';
import { erzeugeLektionen, PROBEFRAGEN } from './helfer/wortsuche-korpus.js';

const zusatz = [
  'Zeitgrenze', 'Datenbank-Verbindung', 'ü ö ä Straße', 'API_KEY', 'ΑΒΓ', 'デプロイ', 'نشر', 'a', 'ab', 'abc', 'abcd', '   ',
  'deploy; ; api', 'node-1 node-2 node-3', 'caddyfile', 'cach', 'deplo', 'xyzzyx', 'timeoutt', 'retr', 'Zwischenspeichr', 'Wortsuhce Bestandd', 'privilegee seperation', 'deploymentt gatewayy', 'keycloakk realmm',
];

let bestand: Wortbestand;
const alterWert = process.env.CACHLY_RECALL_NUR_LESEN;

beforeAll(() => {
  process.env.CACHLY_RECALL_NUR_LESEN = '1';
  // 350 statt 600 Lektionen (19.11.2026): Die eingefrorene alte Funktion ist
  // genau das Langsame, das ersetzt wurde. Mit 600 brauchte dieser Test auf
  // dem Runner 57 s am Stueck, und vitest meldete "Timeout calling
  // onTaskUpdate" als unbehandelten Fehler — 3.691 Tests gruen, Veroeffent-
  // lichung von 0.10.264 trotzdem rot. Die Fragen bleiben alle 75.
  const b = bestandAusDokumenten(erzeugeLektionen(350));
  if (!b) throw new Error('kein Bestand');
  bestand = b;
  return () => {
    if (alterWert === undefined) delete process.env.CACHLY_RECALL_NUR_LESEN;
    else process.env.CACHLY_RECALL_NUR_LESEN = alterWert;
  };
});

const form = (r: ReturnType<typeof keywordSearchMitBestand>) => r.map((m) => ({
  key: m.key,
  score: Number(m.score.toFixed(6)),
  matchedWords: m.matchedWords,
  wortBelege: m.wortBelege,
  subQuery: m.subQuery,
}));

describe('Wortsuche: schnell == eingefroren', () => {
  const fragen = [...PROBEFRAGEN, ...zusatz];
  it('mindestens 50 Fragen', () => { expect(fragen.length).toBeGreaterThanOrEqual(50); });

  // Nach jeder Frage gibt der Test die Ereignisschleife frei. Sonst erreicht
  // vitest seinen Arbeitsprozess minutenlang nicht (siehe oben).
  const kurzePause = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('alle Fragen liefern dieselbe Rangliste (Top 25) und dieselbe Rangliste (alle Treffer)', async () => {
    let verglichen = 0;
    for (const q of fragen) {
      for (const topK of [25, 100000]) {
        const neu = form(keywordSearchMitBestand(bestand, q, topK));
        const alt = form(keywordSearchMitBestandAlt(bestand, q, topK));
        expect(neu, `Frage: ${q} (topK ${topK})`).toEqual(alt);
        verglichen++;
        await kurzePause();
      }
    }
    expect(verglichen).toBe(fragen.length * 2);
  }, 180_000);

  it('zweiter Durchlauf (Zwischenspeicher warm) bleibt gleich', async () => {
    for (const q of fragen.slice(0, 20)) {
      expect(form(keywordSearchMitBestand(bestand, q, 25))).toEqual(form(keywordSearchMitBestandAlt(bestand, q, 25)));
      await kurzePause();
    }
  }, 120_000);
});

describe('levenshteinHoechstens2 == (levenshtein <= 2)', () => {
  it('stimmt auf Zufallspaaren und Randfaellen', () => {
    let s = 12345;
    const z = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    const wort = (n: number) => Array.from({ length: n }, () => 'abcde'[Math.floor(z() * 5)]).join('');
    const paare: Array<[string, string]> = [['abcd', 'abcd'], ['abcd', 'abxd'], ['abcd', 'a'], ['abcd', ''], ['', ''], ['abcdef', 'abdf']];
    for (let i = 0; i < 20000; i++) {
      const a = wort(1 + Math.floor(z() * 10));
      const b = z() < 0.5 ? wort(1 + Math.floor(z() * 10)) : a.slice(0, Math.floor(z() * a.length)) + wort(Math.floor(z() * 3)) + a.slice(Math.floor(z() * a.length));
      paare.push([a, b]);
    }
    for (const [a, b] of paare) expect(levenshteinHoechstens2(a, b), `${a} | ${b}`).toBe(levenshtein(a, b) <= 2);
  });
});
