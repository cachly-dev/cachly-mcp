/**
 * ABNAHME Stufe 2, Teil B1 (eingefroren 27.11.2026): Findet die Einblendung je
 * Prompt den passenden Wissens-Eintrag, wenn ein Neuer in EIGENEN Worten fragt?
 *
 * Vorher-Zahlen:
 *   - Wort-Tor ueber Lektionen (messung-wissen-je-prompt.test.ts, origin/main 55d3347b):
 *     gleiche Woerter 9/12, eigene Worte 1/12 (Bestand 1.671).
 *   - Bedeutungsabgleich (MESSUNG-bedeutung-2026-11-27.md): eigener Topf mit 12 Eintraegen
 *     Top 3 = 10/12; gemischt mit 300 echten Lektionen Top 3 = 1/12; Leser macht es schlechter.
 *   Darum der Vertrag unten: Wissen hat einen EIGENEN Topf und einen EIGENEN Platz. Kein Leser.
 *
 * So laeuft sie (wie die Abnahme von Stufe 1):
 *   1. Diese Datei und wissen-12.fixture.json nach sdk/mcp/src/__tests__/ kopieren.
 *   2. vektoren-wissen.fixture.json daneben legen (Format unten).
 *   3. BESTAND=<Export mit rund 1.671 Lektionen> npx vitest run src/__tests__/abnahme-wissen-eigene-worte.test.ts
 *
 * HEUTE ROT: '../wissenssuche.js' gibt es nicht. Das ist gewollt.
 *
 * Vertrag, den PR 4 erfuellen muss (sdk/mcp/src/wissenssuche.ts):
 *
 *   export interface WissensTreffer {
 *     id: string; ebene: 'brain' | 'firma';
 *     titel: string; text: string;
 *     naehe: number;                                  // Kosinus 0..1, vom Server
 *     quelle?: { pfad: string; ueberschrift: string; link: string };
 *   }
 *   export type WissensSuche = (frage: string, k: number) => Promise<WissensTreffer[]>;
 *   export const WISSEN_PLATZ_MAX = 3;                // hoechstens 3 Eintraege
 *   export const WISSEN_PLATZ_TOKEN = 300;            // eigener Deckel, zusaetzlich zu den 600 der Lektionen
 *   export async function wissensPlatz(prompt: string, suche: WissensSuche | null):
 *     Promise<{ treffer: WissensTreffer[]; text: string; tokens: number; stand: 'an' | 'aus' | 'leer' | 'fehler' }>;
 *
 *   - suche === null: stand 'aus', nichts. Suche wirft: stand 'fehler', nichts. Nie eine Ausnahme nach aussen.
 *   - Prompt mit weniger als 3 Woertern: die Suche wird NICHT gerufen (stand 'leer').
 *   - `text` steht im Rahmen <cachly-memory> (Daten, keine Anweisungen) und nennt je Treffer die Quelle.
 *   - Der Platz der Lektionen (selectRelevant) bleibt, wie er ist.
 *
 * Format vektoren-wissen.fixture.json (echte bge-m3-Vektoren, 1.024 Zahlen je Text):
 *   { "modell": "BAAI/bge-m3", "dim": 1024,
 *     "fragen": { "<Fragetext wortgleich>": [..] },   // 12 nah + 12 fern + 12 fehlfragen = 36
 *     "wissen": { "<topic>": [..] },                  // die 12, Text "topic: text" wie in der Messung
 *     "topf_gross": { "<id>": [..] } }                // freiwillig: 300 Abschnitte aus echten Markdown-Dateien
 *
 * ZAHLEN
 *   ZIEL_FERN 9  = gemessene 10/12 minus 1 (der Platz hat einen Token-Deckel und eine Untergrenze).
 *   ZIEL_NAH  11 = gemessene 12/12 minus 1.
 *   MAX_FEHL  6  = [HYPOTHESE]. Die Naehe der Fehlfragen im eigenen Topf ist NICHT gemessen. Sobald die
 *                  Vektor-Datei da ist, wird MAX_FEHL EINMAL auf "gemessen + 1" gesetzt und eingefroren.
 *   BODEN_GROSS entfaellt: gemessen im Topf von 312 sind es 1/12 (nicht 7). Dort gilt nur das Rauschen.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectRelevant } from '../einblendung.js';
import { wissensPlatz } from '../wissenssuche.js';

const ZIEL_NAH = 11;
const ZIEL_FERN = Number(process.env.ZIEL_FERN ?? 9);
// Gemessen mit Untergrenze 0,40 im Topf von 12: 5 von 12 Fehlfragen zeigen etwas. +1, eingefroren (27.11.2026).
const MAX_FEHL = Number(process.env.MAX_FEHL ?? 6);
const ALT_NAH = 9; // Wort-Tor ueber Lektionen, darf nicht fallen

const hier = dirname(fileURLToPath(import.meta.url));
const satz = JSON.parse(readFileSync(join(hier, 'wissen-12.fixture.json'), 'utf8')) as {
  lektionen: Array<{ topic: string; text: string; nah: string; fern: string }>;
  fehlfragen: string[];
};
const vekPfad = process.env.VEKTOREN ?? join(hier, 'vektoren-wissen.fixture.json');
type Vektoren = { dim: number; fragen: Record<string, number[]>; wissen: Record<string, number[]>; topf_gross?: Record<string, number[]> };
const ladeVektoren = (): Vektoren => JSON.parse(readFileSync(vekPfad, 'utf8'));

function kosinus(a: number[], b: number[]): number {
  let s = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? s / Math.sqrt(na * nb) : 0;
}

/**
 * Die Regel des Servers (api/internal/wissen/grenzen.go, Untergrenze): bis 50 Eintraege
 * 0,40, darueber 0,50. `fits` setzt der Server; die Abnahme bildet es mit derselben Regel nach.
 */
const untergrenze = (pool: number) => (pool <= 50 ? 0.4 : 0.5);

/** Die "API" der Abnahme: reiner Bedeutungsabgleich ueber den eigenen Topf. */
function sucheUeber(v: Vektoren, topf: Record<string, number[]>, zaehler = { rufe: 0 }) {
  const texte = new Map(satz.lektionen.map((l) => [l.topic, l.text]));
  const grenze = untergrenze(Object.keys(topf).length);
  return async (frage: string, k: number) => {
    zaehler.rufe++;
    const q = v.fragen[frage];
    if (!q) throw new Error(`kein Vektor fuer Frage: ${frage}`);
    return Object.keys(topf)
      .map((id) => ({ id, ebene: 'firma' as const, titel: id, text: texte.get(id) ?? 'Abschnitt aus einem Dokument.', naehe: kosinus(q, topf[id]), fits: false }))
      .map((t) => ({ ...t, fits: t.naehe >= grenze }))
      .sort((a, b) => b.naehe - a.naehe)
      .slice(0, k);
  };
}

async function zaehle(v: Vektoren, topf: Record<string, number[]>) {
  const suche = sucheUeber(v, topf);
  let nah = 0; let fern = 0; const fehltFern: string[] = [];
  for (const l of satz.lektionen) {
    const n = await wissensPlatz(l.nah, suche);
    const f = await wissensPlatz(l.fern, suche);
    for (const r of [n, f]) {
      expect(r.treffer.length).toBeLessThanOrEqual(3);
      expect(r.tokens).toBeLessThanOrEqual(300);
      if (r.treffer.length > 0) expect(r.text).toContain('<cachly-memory');
    }
    if (n.treffer.some((x: { id: string }) => x.id === l.topic)) nah++;
    if (f.treffer.some((x: { id: string }) => x.id === l.topic)) fern++; else fehltFern.push(l.topic);
  }
  let fehl = 0;
  for (const frage of satz.fehlfragen) {
    const r = await wissensPlatz(frage, suche);
    if (r.treffer.length > 0) fehl++;
  }
  return { nah, fern, fehl, fehltFern };
}

describe('ABNAHME Stufe 2: Wissen in eigenen Worten', () => {
  it('Voraussetzung: Vektor-Datei liegt vor', () => {
    expect(existsSync(vekPfad), `Vektor-Datei fehlt: ${vekPfad}`).toBe(true);
    const v = ladeVektoren();
    expect(v.dim).toBe(1024);
    expect(Object.keys(v.fragen).length).toBeGreaterThanOrEqual(36);
    expect(Object.keys(v.wissen).length).toBe(12);
  });

  it(`eigener Topf (12): gleiche Woerter >= ${ZIEL_NAH}/12, eigene Worte >= ${ZIEL_FERN}/12, Fehlfragen <= ${MAX_FEHL}/12`, async () => {
    const v = ladeVektoren();
    const z = await zaehle(v, v.wissen);
    console.log(`\nTopf 12:  nah ${z.nah}/12  fern ${z.fern}/12  fehl ${z.fehl}/12\nfern verfehlt: ${z.fehltFern.join(', ')}\n`);
    expect(z.nah).toBeGreaterThanOrEqual(ZIEL_NAH);
    expect(z.fern).toBeGreaterThanOrEqual(ZIEL_FERN);
    expect(z.fehl).toBeLessThanOrEqual(MAX_FEHL);
  });

  // Gemessen (27.11.2026, Untergrenze 0,50): eigene Worte 1/12, Fehlfragen 6/12. Der Boden BODEN_GROSS (7)
  // war eine Hypothese und ist widerlegt (MESSUNG-bedeutung, Nachtrag "grosser Topf"); die faire Probe mit
  // 40 echten Abschnitten steckt nicht in dieser Datei. Fest steht hier nur das Rauschen: <= MAX_FEHL/12.
  it(`grosser Topf (12 + 300 Dokument-Abschnitte), Untergrenze 0,50: Fehlfragen <= ${MAX_FEHL}/12 (eigene Worte nur berichtet)`, async (ctx) => {
    const v = ladeVektoren();
    if (!v.topf_gross || Object.keys(v.topf_gross).length < 300) { console.log('\nUEBERSPRUNGEN: topf_gross fehlt — Risiko R6 bleibt ungemessen\n'); return ctx.skip(); }
    const z = await zaehle(v, { ...v.topf_gross, ...v.wissen });
    console.log(`\nTopf 312: nah ${z.nah}/12  fern ${z.fern}/12  fehl ${z.fehl}/12\nfern verfehlt: ${z.fehltFern.join(', ')}\n`);
    expect(z.nah).toBeGreaterThanOrEqual(ZIEL_NAH);
    expect(z.fehl).toBeLessThanOrEqual(MAX_FEHL);
  });

  it('ohne Suche, bei Fehler und bei Kurz-Prompts: nichts, keine Ausnahme, kein Aufruf', async () => {
    const v = existsSync(vekPfad) ? ladeVektoren() : { dim: 1024, fragen: {}, wissen: {} };
    const ohne = await wissensPlatz(satz.lektionen[0].fern, null);
    expect(ohne.stand).toBe('aus'); expect(ohne.treffer).toEqual([]); expect(ohne.text).toBe('');
    const kaputt = await wissensPlatz(satz.lektionen[0].fern, async () => { throw new Error('zeitlimit'); });
    expect(kaputt.stand).toBe('fehler'); expect(kaputt.text).toBe('');
    const zaehler = { rufe: 0 };
    const kurz = await wissensPlatz('ok weiter', sucheUeber(v, v.wissen, zaehler));
    expect(kurz.stand).toBe('leer'); expect(zaehler.rufe).toBe(0);
  });

  it(`der Platz der Lektionen bleibt: Wort-Tor gleiche Woerter >= ${ALT_NAH}/12 im echten Bestand`, (ctx) => {
    const pfad = process.env.BESTAND ?? '';
    // Ohne echten Export (rund 1.671 Lektionen) gibt es nichts zu messen; die CI hat keinen.
    if (!pfad) { console.log('UEBERSPRUNGEN: BESTAND nicht gesetzt'); return ctx.skip(); }
    expect(existsSync(pfad), `BESTAND zeigt auf keine Datei: ${pfad}`).toBe(true);
    const d = JSON.parse(readFileSync(pfad, 'utf8'));
    const alt = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const zwoelf = satz.lektionen.map((l) => ({
      topic: l.topic, what_worked: l.text, outcome: 'success', severity: 'major', recall_count: 0,
      ts: alt, verified_at: alt, confidence: 1, tags: ['wissen'], author: 'admin',
    }));
    const alle = [...(Array.isArray(d) ? d : (d.lessons ?? [])), ...zwoelf] as never[];
    const nah = satz.lektionen.filter((l) => selectRelevant(l.nah, alle).lessons.some((x) => x.topic === l.topic)).length;
    expect(nah).toBeGreaterThanOrEqual(ALT_NAH);
  });
});
