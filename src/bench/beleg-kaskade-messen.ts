/**
 * ══ Die Beleg-Kaskade: sortieren wie ein Gericht, nicht wie eine Waage ═════
 *
 * ── Der gemessene Anlass (27.08.2026) ──────────────────────────────────────
 *
 * Auf dem eingefrorenen Pruefsatz liegen 98 von 100 richtigen Antworten in
 * der Vorauswahl — gezeigt werden 59. Der Verlust sitzt vollstaendig in der
 * Sortierung. Und die Schuldzerlegung nach Frageart zeigt, WO:
 *
 *     stoerung (traegt Fehlertext)   67 %
 *     nachschlagen                   61 %
 *     vorhaben                       52 %
 *     entscheidung                   50 %
 *
 * Fragearten mit einem SCHARFEN Schluessel (woertlicher Fehlertext, seltenes
 * Wort) laufen gut. Der Rest verliert — und zwar an die Punktsumme selbst:
 * ein scharfer Beleg wird dort mit weichen Aehnlichkeiten VERRECHNET, und 97
 * weiche Kandidaten stimmen einen harten nieder. Dieselbe Messreihe vom
 * 20.08. sagt es woertlich: ohne die Fehlertext-Tueren faellt der gesamte
 * Gewinn der Eingaenge auf null zurueck.
 *
 * ── Die Idee ───────────────────────────────────────────────────────────────
 *
 * Ein Gericht wiegt Beweise nicht alle in einer Summe. Es ordnet sie nach
 * KLASSEN: eine Urkunde schlaegt ein Indiz, ein Indiz schlaegt ein Gefuehl —
 * egal, wie viele Gefuehle sich addieren. Genau das macht die Kaskade:
 *
 *     Klasse 1  scharfe Tuer          bE >= s1   (Fehlertext/Eingang passt)
 *     Klasse 2  seltene Frageworte    sD >= s2   (die Woerter stehen drin)
 *     Klasse 3  nur Aehnlichkeit      der Rest
 *
 * Ein Kandidat hoeherer Klasse steht IMMER ueber jedem niedrigerer Klasse.
 * Die Punktsumme sortiert nur noch INNERHALB einer Klasse. Aehnlichkeit darf
 * also weiter entscheiden — aber nie mehr einen harten Beleg ueberstimmen.
 *
 * Kein neues Merkmal, kein Modellaufruf, keine Wartezeit: dieselben Zahlen,
 * andere Ordnung. Nur die Verrechnung aendert sich — von "gewogen" zu
 * "erst geordnet, dann gewogen".
 *
 * ── Was diese Messung beweisen kann und was nicht ─────────────────────────
 *
 * Sie laeuft auf dem EINSTELLsatz (2997 Fragen). Die Schwellen s1/s2 werden
 * hier gesiebt; der eingefrorene Pruefsatz wird NICHT angefasst. Erst wenn
 * eine Einstellung hier traegt, wird sie GENAU EINMAL am Pruefsatz bestaetigt
 * (Oeffnungen sind knapp — Naturworkshop-2-Regel: am Einstellsatz sieben,
 * nur Ueberlebende bestaetigen).
 *
 * ── Warum die Grundlinie geeicht wird ─────────────────────────────────────
 *
 * Die Punktzahl je Kandidat entsteht NICHT hier: `punktzahl()` setzt sie
 * exakt so zusammen wie `bewerte()` in gewichte-anpassen.ts — bewerteTopf
 * aus dem Produkt plus Eingangs-Spreizung. Und damit das nicht Behauptung
 * bleibt, rechnet die Eichprobe beide Wege ueber denselben Zeilen und
 * verlangt ZIFFERNGLEICHE Ergebnisse. Weicht eine Stelle ab, ist dieser
 * Messstand ein zweites System — die Fehlerklasse vom 20.08.2026 — und
 * bricht ab, statt zu messen.
 *
 * Aufruf:
 *   npx tsx src/bench/beleg-kaskade-messen.ts --merkmale <datei.jsonl>
 *   npx tsx src/bench/beleg-kaskade-messen.ts --selbstprobe
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { bewerteTopf, spreizeImTopf, GEWICHTE } from '../rangfolge.js';
import { EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';
import { bewerte, type Ergebnis } from './gewichte-anpassen.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const proz = (x: number) => `${(x * 100).toFixed(1)} %`;

/**
 * Dieselbe Zusammensetzung wie gewichte-anpassen.bewerte — siehe Eichprobe.
 *
 * Exportiert, weil stichentscheid-messen.ts dieselbe Punktzahl braucht.
 * Eine dritte Abschrift waere die Zwei-Systeme-Falle in ihrer dritten Auflage.
 */
export function punktzahl(topf: Kandidat[]): number[] {
  const bewertbar = topf.map((k) => ({
    naeheText: k.nT, naeheThema: k.nTh, naeheRueckkopplung: k.nR, seltenheitsDeckung: k.sD,
  }));
  let punkte = bewerteTopf(bewertbar, GEWICHTE);
  if (EINGANG_SORTIER_GEWICHT > 0) {
    const gespreizt = spreizeImTopf(topf.map((k) => k.bE));
    punkte = punkte.map((p, i) => p + EINGANG_SORTIER_GEWICHT * gespreizt[i]);
  }
  return punkte;
}

/** Beleg-Klasse: 1 scharfe Tuer, 2 seltene Worte, 3 nur Aehnlichkeit. */
function klasseVon(k: Kandidat, s1: number, s2: number): number {
  if (k.bE >= s1) return 1;
  if (k.sD >= s2) return 2;
  return 3;
}

function platzVon(rangfolge: string[], relevant: string[]): number {
  const gold = new Set(relevant);
  for (let i = 0; i < rangfolge.length; i++) if (gold.has(rangfolge[i])) return i + 1;
  return 0;
}

/** Grundlinie: reine Punktsumme — MUSS bewerte() aus dem Anpasser gleichen. */
function grundlinie(zeilen: Zeile[]): Ergebnis & { jeArt: Map<string, { n: number; a3: number }> } {
  let p1 = 0; let a3 = 0; let t10 = 0;
  const jeArt = new Map<string, { n: number; a3: number }>();
  for (const z of zeilen) {
    const punkte = punktzahl(z.topf);
    const rang = z.topf.map((k, i) => ({ t: k.t, p: punkte[i] })).sort((a, b) => b.p - a.p);
    const platz = platzVon(rang.map((r) => r.t), z.relevant);
    const eintrag = jeArt.get(z.art) ?? { n: 0, a3: 0 };
    eintrag.n++;
    if (platz === 1) p1++;
    if (platz >= 1 && platz <= 3) { a3++; eintrag.a3++; }
    if (platz >= 1 && platz <= 10) t10++;
    jeArt.set(z.art, eintrag);
  }
  const n = zeilen.length;
  return { platz1: p1 / n, at3: a3 / n, top10: t10 / n, jeArt };
}

function kaskade(zeilen: Zeile[], s1: number, s2: number): Ergebnis & {
  jeArt: Map<string, { n: number; a3: number }>;
  griff: { k1: number; k2: number };
} {
  let p1 = 0; let a3 = 0; let t10 = 0;
  let mitK1 = 0; let mitK2 = 0;
  const jeArt = new Map<string, { n: number; a3: number }>();
  for (const z of zeilen) {
    const punkte = punktzahl(z.topf);
    const rang = z.topf
      .map((k, i) => ({ t: k.t, p: punkte[i], kl: klasseVon(k, s1, s2) }))
      .sort((a, b) => a.kl - b.kl || b.p - a.p);
    if (rang.some((r) => r.kl === 1)) mitK1++;
    else if (rang.some((r) => r.kl === 2)) mitK2++;
    const platz = platzVon(rang.map((r) => r.t), z.relevant);
    const eintrag = jeArt.get(z.art) ?? { n: 0, a3: 0 };
    eintrag.n++;
    if (platz === 1) p1++;
    if (platz >= 1 && platz <= 3) { a3++; eintrag.a3++; }
    if (platz >= 1 && platz <= 10) t10++;
    jeArt.set(z.art, eintrag);
  }
  const n = zeilen.length;
  return {
    platz1: p1 / n, at3: a3 / n, top10: t10 / n, jeArt,
    griff: { k1: mitK1 / n, k2: mitK2 / n },
  };
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // Ein Kandidat mit scharfer Tuer steht ueber einem mit hoeherer Punktsumme.
  const z: Zeile = {
    query: 'probe', art: 'stoerung', relevant: ['tuer-treffer'],
    topf: [
      { t: 'aehnlich-aber-falsch', nT: 0.95, nTh: 0.9, nR: 0.9, sD: 0, bE: 0.1 },
      { t: 'tuer-treffer', nT: 0.4, nTh: 0.3, nR: 0.3, sD: 0.2, bE: 0.9 },
    ],
  };
  const punkte = punktzahl(z.topf);
  p('die Punktsumme allein wuerde FALSCH sortieren', punkte[0] > punkte[1]);
  const k = kaskade([z], 0.7, 0.5);
  p('die Kaskade stellt den Tuer-Treffer auf Platz 1', k.platz1 === 1);

  // Ohne scharfen Beleg faellt alles in Klasse 3 — dann gleicht sie der Summe.
  const z2: Zeile = {
    query: 'vage', art: 'entscheidung', relevant: ['b'],
    topf: [
      { t: 'a', nT: 0.5, nTh: 0.2, nR: 0.4, sD: 0.1, bE: 0.1 },
      { t: 'b', nT: 0.8, nTh: 0.4, nR: 0.7, sD: 0.1, bE: 0.2 },
    ],
  };
  const g2 = grundlinie([z2]);
  const k2 = kaskade([z2], 0.7, 0.5);
  p('ohne Beleg aendert die Kaskade NICHTS', g2.platz1 === k2.platz1 && g2.at3 === k2.at3);

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function ladeZeilen(pfad: string): Promise<Zeile[]> {
  const zeilen: Zeile[] = [];
  const leser = createInterface({ input: createReadStream(pfad), crlfDelay: Infinity });
  for await (const z of leser) {
    if (!z.trim()) continue;
    zeilen.push(JSON.parse(z) as Zeile);
  }
  return zeilen;
}

async function main(): Promise<void> {
  if (process.argv.includes('--selbstprobe')) selbstprobe();

  const pfad = flag('merkmale');
  if (!pfad) {
    console.error('NICHT GEMESSEN: --merkmale <datei.jsonl> ist Pflicht.');
    process.exit(2);
  }
  const zeilen = await ladeZeilen(resolve(pfad));
  if (zeilen.length < 100) {
    console.error(`NICHT GEMESSEN: nur ${zeilen.length} Zeilen.`);
    process.exit(3);
  }

  console.log('');
  console.log('⚖️  Beleg-Kaskade gegen Punktsumme — auf dem EINSTELLsatz');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${zeilen.length} Fragen · Merkmale aus ${pfad}`);

  // ── Eichprobe: die Grundlinie hier MUSS bewerte() aus dem Anpasser gleichen.
  const eigene = grundlinie(zeilen);
  const fremde = bewerte(zeilen, {
    text: GEWICHTE.text, thema: GEWICHTE.thema, rueckkopplung: GEWICHTE.rueckkopplung,
    seltenheit: GEWICHTE.seltenheit, eingang: EINGANG_SORTIER_GEWICHT,
  });
  const gleich = Math.abs(eigene.at3 - fremde.at3) < 1e-12
    && Math.abs(eigene.platz1 - fremde.platz1) < 1e-12;
  if (!gleich) {
    console.error('EICHPROBE ROT: die Grundlinie weicht von gewichte-anpassen.bewerte ab.');
    console.error(`  hier @3 ${proz(eigene.at3)} / dort ${proz(fremde.at3)}`);
    console.error('  Dieser Messstand waere ein ZWEITES System. Abbruch statt Messung.');
    process.exit(1);
  }
  console.log(`  Eichprobe: Grundlinie ist zifferngleich mit gewichte-anpassen (ok)`);
  console.log('');
  console.log(`  Grundlinie (Punktsumme):  Platz 1 ${proz(eigene.platz1)} · @3 ${proz(eigene.at3)} · Top 10 ${proz(eigene.top10)}`);
  console.log('');

  // ── Das Sieb: Schwellenraster, nur auf dem Einstellsatz ──────────────────
  console.log('  s1 (Tuer)  s2 (Worte)   Platz 1      @3        Top 10    greift K1/K2');
  let beste = { s1: 0, s2: 0, at3: -1, platz1: -1, zeilentext: '' };
  for (const s1 of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    for (const s2 of [0.34, 0.5, 0.67, 1.01]) {
      const k = kaskade(zeilen, s1, s2);
      const zeilentext = `    ${s1.toFixed(2)}      ${s2 > 1 ? 'aus ' : s2.toFixed(2)}      ${proz(k.platz1).padStart(7)}  ${proz(k.at3).padStart(7)}  ${proz(k.top10).padStart(7)}    ${proz(k.griff.k1)} / ${proz(k.griff.k2)}`;
      console.log(zeilentext);
      if (k.at3 > beste.at3 || (k.at3 === beste.at3 && k.platz1 > beste.platz1)) {
        beste = { s1, s2, at3: k.at3, platz1: k.platz1, zeilentext };
      }
    }
  }

  console.log('');
  console.log(`  Beste Einstellung: s1=${beste.s1} s2=${beste.s2}`);
  const delta3 = (beste.at3 - eigene.at3) * 100;
  const delta1 = (beste.platz1 - eigene.platz1) * 100;
  console.log(`  Gegen die Grundlinie: @3 ${delta3 >= 0 ? '+' : ''}${delta3.toFixed(1)} Punkte · Platz 1 ${delta1 >= 0 ? '+' : ''}${delta1.toFixed(1)} Punkte`);

  // ── Nach Frageart: hilft sie dort, wo der Verlust gemessen ist? ─────────
  const kBest = kaskade(zeilen, beste.s1, beste.s2);
  console.log('');
  console.log('  Nach Frageart (@3, Grundlinie -> Kaskade):');
  const arten = [...eigene.jeArt.keys()].sort();
  for (const art of arten) {
    const g = eigene.jeArt.get(art);
    const kk = kBest.jeArt.get(art);
    if (!g || !kk || g.n === 0) continue;
    console.log(`    ${art.padEnd(14)} ${proz(g.a3 / g.n).padStart(7)} -> ${proz(kk.a3 / kk.n).padStart(7)}   (${g.n} Fragen)`);
  }
  console.log('');
  console.log('  Naechster Schritt NUR wenn der Gewinn traegt: EIN Bestaetigungslauf');
  console.log('  am eingefrorenen Pruefsatz — nicht hier, der ist zu schonen.');
}

// Nur beim DIREKTEN Start laufen — dieselbe Falle, die dieses Skript heute
// selbst in gewichte-anpassen.ts gefunden hat: ein Import feuerte dort das
// main() mit und beendete den Importeur mit Exit 2. Wer `punktzahl`
// importiert, will messen, nicht diesen Messstand starten.
const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('beleg-kaskade-messen.ts');
if (direktGestartet) {
  main().catch((e: unknown) => {
    console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
