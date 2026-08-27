/**
 * ══ Die Gewichte anpassen statt abtasten ═══════════════════════════════════
 *
 * ── Der Anlass ────────────────────────────────────────────────────────────
 *
 * Die Gewichte der Rangfolge — text 1,0 · thema 0,6 · rueckkopplung 0,3 ·
 * seltenheit 1,3 · Eingang 0,2 — sind von Hand abgetastet worden, jedes
 * einzeln, auf 100 Fragen. Sie sind das beste Wissen von jemandem, nicht das
 * Ergebnis von Faellen.
 *
 * Seit dem 22.08.2026 liegen 2997 Einstellfragen und 3003 Pruefungsfragen
 * bereit, ueberschneidungsfrei getrennt, ueber vier Achsen geschichtet. Sie
 * sind nie benutzt worden.
 *
 * ── Warum das ueberhaupt schnell geht ────────────────────────────────────
 *
 * Ein voller Lauf ueber 2997 Fragen kostet 243 Sekunden. Dreissig Gewichtungen
 * waeren zwei Stunden.
 *
 * Die Merkmale haengen aber nicht von den Gewichten ab — nur ihre Verrechnung.
 * `findequote-messen.ts --merkmale-nach` schreibt sie einmal aus (23 MB), und
 * dieser Anpasser bewertet daraus in Millisekunden.
 *
 * ── Die Regel, die dabei nicht gebrochen werden darf ─────────────────────
 *
 * Dieser Anpasser rechnet die Punktzahl NICHT selbst nach. Er ruft dieselbe
 * `bewerteTopf` und dieselbe `spreizeImTopf`, die im Produkt sortieren. Ein
 * eigener Nachbau waere ein zweiter Messstand — genau der Fehler vom
 * 20.08.2026, als der Messstand mit `bewerteTopf` sortierte und der
 * ausgelieferte Pfad mit RRF. Die Eingaenge brachten dort +6 Punkte und im
 * Produkt +1.
 *
 * ── Und was er ausdruecklich NICHT tut ───────────────────────────────────
 *
 * Er fasst den Pruefsatz nicht an. Angepasst wird auf dem EINSTELLsatz;
 * abgenommen wird genau einmal, am Ende, von Hand, auf dem Pruefsatz. Wer
 * beim Suchen auf den Pruefsatz schaut, misst seine eigene Anpassung.
 *
 * Aufruf:
 *   npx tsx src/bench/gewichte-anpassen.ts --merkmale <datei.jsonl>
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { bewerteTopf, spreizeImTopf, GEWICHTE } from '../rangfolge.js';
import { EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };

type Gewichte = { text: number; thema: number; rueckkopplung: number; seltenheit: number };
type Einstellung = Gewichte & { eingang: number };

export type Ergebnis = { platz1: number; at3: number; top10: number };

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Bewertet EINE Einstellung ueber alle Fragen.
 *
 * Ruft `bewerteTopf` und `spreizeImTopf` aus dem Produktionsmodul — die
 * Punktzahl entsteht hier nicht neu.
 */
export function bewerte(zeilen: Zeile[], e: Einstellung): Ergebnis {
  let p1 = 0; let a3 = 0; let t10 = 0;
  const gewichte = {
    text: e.text, thema: e.thema, rueckkopplung: e.rueckkopplung, seltenheit: e.seltenheit,
  } as typeof GEWICHTE;

  for (const z of zeilen) {
    const bewertbar = z.topf.map((k) => ({
      naeheText: k.nT,
      naeheThema: k.nTh,
      naeheRueckkopplung: k.nR,
      seltenheitsDeckung: k.sD,
    }));
    let punkte = bewerteTopf(bewertbar, gewichte);
    if (e.eingang > 0) {
      const gespreizt = spreizeImTopf(z.topf.map((k) => k.bE));
      punkte = punkte.map((p, i) => p + e.eingang * gespreizt[i]);
    }
    const rang = z.topf
      .map((k, i) => ({ t: k.t, p: punkte[i] }))
      .sort((a, b) => b.p - a.p);

    const gold = new Set(z.relevant);
    let platz = 0;
    for (let i = 0; i < rang.length; i++) {
      if (gold.has(rang[i].t)) { platz = i + 1; break; }
    }
    if (platz === 1) p1++;
    if (platz >= 1 && platz <= 3) a3++;
    if (platz >= 1 && platz <= 10) t10++;
  }
  const n = zeilen.length;
  return { platz1: p1 / n, at3: a3 / n, top10: t10 / n };
}

/**
 * Die Zielgroesse.
 *
 * Findequote@3 zaehlt, weil der Mensch drei Lektionen sieht. Platz 1 bricht
 * den Gleichstand — bei gleicher @3 ist die Einstellung besser, die oefter
 * gleich richtig liegt.
 */
function guete(r: Ergebnis): number {
  return r.at3 * 1000 + r.platz1;
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

const proz = (x: number) => `${(x * 100).toFixed(1)} %`;

async function main(): Promise<void> {
  const pfad = flag('merkmale');
  if (!pfad) {
    console.error('NICHT GEMESSEN: --merkmale <datei.jsonl> ist Pflicht.');
    console.error('  Erzeugen mit: findequote-messen.ts … --merkmale-nach <datei.jsonl>');
    process.exit(2);
  }

  const zeilen = await ladeZeilen(resolve(pfad));
  if (zeilen.length < 100) {
    console.error(`NICHT GEMESSEN: nur ${zeilen.length} Zeilen — das traegt keine Anpassung.`);
    process.exit(3);
  }

  /*
   * Der Startpunkt ist ueblicherweise der ausgelieferte Stand. Mit `--start`
   * laesst er sich setzen — und genau das ist die schaerfste Probe auf
   * Verallgemeinerung: startet man auf einem FREMDEN Bestand von den ALTEN
   * Gewichten und landet trotzdem bei den neuen, dann sind sie nicht unsere
   * Eigenheit, sondern die Sache selbst.
   */
  const start: Einstellung = flag('start')
    ? (() => {
      const e: Einstellung = {
        text: 1, thema: 0, rueckkopplung: 0, seltenheit: 0, eingang: 0,
      };
      for (const teil of (flag('start') ?? '').split(',').filter(Boolean)) {
        const [k, v] = teil.split('=');
        if (k.trim() in e) (e as unknown as Record<string, number>)[k.trim()] = Number(v);
      }
      return e;
    })()
    : {
      text: GEWICHTE.text,
      thema: GEWICHTE.thema,
      rueckkopplung: GEWICHTE.rueckkopplung,
      seltenheit: GEWICHTE.seltenheit,
      eingang: EINGANG_SORTIER_GEWICHT,
    };

  console.log('');
  console.log('⚖️  Gewichte anpassen — auf dem EINSTELLsatz');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${zeilen.length} Fragen · Merkmale aus ${pfad}`);
  console.log('');

  const s0 = bewerte(zeilen, start);
  console.log('  Ausgangsstand (die abgetasteten Gewichte)');
  console.log(`    Platz 1 ${proz(s0.platz1)} · @3 ${proz(s0.at3)} · Top 10 ${proz(s0.top10)}`);
  console.log(`    text ${start.text} · thema ${start.thema} · rueckkopplung ${start.rueckkopplung}`
    + ` · seltenheit ${start.seltenheit} · eingang ${start.eingang}`);
  console.log('');

  /*
   * Koordinatensuche. Kein Verfahren mit Ableitungen: die Zielgroesse ist eine
   * Trefferzahl, also stufig und nicht differenzierbar. Ein Merkmal nach dem
   * anderen, mehrere Runden, bis sich nichts mehr bewegt.
   *
   * `text` bleibt fest auf 1: die Skala ist frei, nur die VERHAELTNISSE
   * zaehlen. Ein Freiheitsgrad weniger, keine verlorene Loesung.
   */
  const achsen: Array<[keyof Einstellung, number[]]> = [
    ['thema', [0, 0.2, 0.4, 0.6, 0.8, 1.0, 1.3]],
    ['rueckkopplung', [0, 0.15, 0.3, 0.5, 0.8]],
    ['seltenheit', [0.6, 0.9, 1.3, 1.6, 2.0, 2.5]],
    ['eingang', [0, 0.1, 0.2, 0.35, 0.5, 0.7]],
  ];

  let beste = { ...start };
  let besteGuete = guete(s0);
  let laeufe = 1;

  for (let runde = 1; runde <= 3; runde++) {
    let bewegt = false;
    for (const [achse, werte] of achsen) {
      for (const w of werte) {
        if (beste[achse] === w) continue;
        const kandidat = { ...beste, [achse]: w };
        const r = bewerte(zeilen, kandidat);
        laeufe++;
        if (guete(r) > besteGuete) {
          besteGuete = guete(r);
          beste = kandidat;
          bewegt = true;
          console.log(`  Runde ${runde}: ${achse} → ${w}   @3 ${proz(r.at3)} · Platz 1 ${proz(r.platz1)}`);
        }
      }
    }
    if (!bewegt) { console.log(`  Runde ${runde}: keine Verbesserung mehr.`); break; }
  }

  const sBest = bewerte(zeilen, beste);
  console.log('');
  console.log(`  ${laeufe} Bewertungen gerechnet.`);
  console.log('');
  console.log('  Bester Stand auf dem EINSTELLsatz');
  console.log(`    Platz 1 ${proz(sBest.platz1)} · @3 ${proz(sBest.at3)} · Top 10 ${proz(sBest.top10)}`);
  console.log(`    text ${beste.text} · thema ${beste.thema} · rueckkopplung ${beste.rueckkopplung}`
    + ` · seltenheit ${beste.seltenheit} · eingang ${beste.eingang}`);
  console.log('');
  console.log(`  Gewinn gegenueber dem Ausgangsstand: @3 ${proz(sBest.at3 - s0.at3)}`
    + ` · Platz 1 ${proz(sBest.platz1 - s0.platz1)}`);

  /*
   * ── Steht das Ergebnis auf einer Messerschneide? ─────────────────────────
   *
   * Ein Optimum, das bei der kleinsten Aenderung wegbricht, ist an den
   * Einstellsatz angepasst und nicht an die Aufgabe. Deshalb werden die
   * Nachbarn mit ausgegeben: bleiben sie in der Naehe, traegt der Fund.
   */
  console.log('');
  console.log('  Nachbarn (haelt das Ergebnis, oder steht es auf der Kante?)');
  for (const [achse] of achsen) {
    const v = beste[achse];
    for (const d of [-0.1, 0.1]) {
      const w = Math.round((v + d) * 100) / 100;
      if (w < 0) continue;
      const r = bewerte(zeilen, { ...beste, [achse]: w });
      console.log(`    ${achse.padEnd(15)} ${String(w).padStart(5)}   @3 ${proz(r.at3)}`
        + `  (${r.at3 >= sBest.at3 - 0.01 ? 'traegt' : 'faellt ab'})`);
    }
  }

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log('  Der Pruefsatz wurde NICHT angefasst. Abnahme genau einmal, von Hand:');
  console.log('    findequote-messen.ts … --pruefsatz pruefsatz-3000.json \\');
  console.log(`      --eingang ${beste.eingang} --gewichte text=${beste.text},thema=${beste.thema},`
    + `rueckkopplung=${beste.rueckkopplung},seltenheit=${beste.seltenheit}`);
}

// Nur beim DIREKTEN Start laufen. `bewerte` ist exportiert und wird von
// beleg-kaskade-messen.ts als Eichquelle importiert — ohne diesen Schutz
// feuerte der Import das main() hier mit, verlangte --merkmale und beendete
// den Importeur mit Exit 2, bevor der eine Zeile gemessen hatte (27.08.2026).
const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('gewichte-anpassen.ts');
if (direktGestartet) {
  main().catch((e) => {
    console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : String(e));
    process.exit(4);
  });
}
