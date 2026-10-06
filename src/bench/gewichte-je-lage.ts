/**
 * ══ Gewichte je Fragenlage — der Ausweg aus dem Dominanz-Beweis ═══════════
 *
 * ── Warum das nicht schon wieder Gewichte-Drehen ist ──────────────────────
 *
 * PR #543 hat bewiesen: mit den heutigen Merkmalen sind hoechstens 65 %
 * Platz 1 / 77,6 % @3 erreichbar — per Dominanz-Argument. Das Argument sagt
 * genau: wer in ALLEN Merkmalen mindestens so gut ist wie ein anderer und in
 * einem besser, gewinnt unter JEDER nichtnegativen Gewichtung. Es gilt fuer
 * EINEN Gewichtssatz.
 *
 * Es gilt NICHT mehr, wenn verschiedene Fragen verschiedene Gewichte
 * bekommen. Dann kann Kandidat X bei Frage 1 gewinnen und bei Frage 2
 * verlieren, obwohl er dominiert — weil die Gewichte andere sind. Die
 * Obergrenze ist damit kein Gesetz mehr, sondern die Obergrenze EINES
 * Verfahrens.
 *
 * Das ist der Grund fuer diese Datei. Nicht "noch ein Abtasten", sondern der
 * einzige bekannte Weg, mit den VORHANDENEN Merkmalen ueber 77,6 % zu kommen —
 * ohne ein Modell im heissen Pfad, ohne eine einzige zusaetzliche Einbettung.
 *
 * ── Woran die Lage erkannt wird ──────────────────────────────────────────
 *
 * Nur an Groessen, die zur Suchzeit VORLIEGEN. Keine Bench-Etiketten wie
 * `guete` — die kennt das Produkt nicht. Verwendet werden Kennzahlen ueber
 * den Topf, die aus den Merkmalen selbst folgen:
 *
 *   maxSD   hoechste Seltenheitsdeckung im Topf
 *           -> "deckt ueberhaupt jemand die seltenen Frageworte?"
 *   maxNT   hoechste Volltext-Naehe im Topf
 *           -> "liegt ueberhaupt etwas bedeutungsnah?"
 *
 * Die Messung vom 01.09. sagt, warum gerade diese zwei: die Verschuetteten
 * sind "in JEDEM heutigen Signal schwach" — wenige gemeinsame Staemme UND
 * mittlere Sinn-Raenge. Wer beides niedrig hat, ist eine andere Aufgabe als
 * wer ein scharfes seltenes Wort teilt.
 *
 * ── Die Messhygiene, ohne die das hier wertlos waere ─────────────────────
 *
 * Mehr Gewichte heisst mehr Anpassung heisst mehr Selbstbetrug. Deshalb:
 *
 *   1. Der Einstellsatz wird HALBIERT (gerade/ungerade Frage).
 *   2. Angepasst wird NUR auf Haelfte A — je Lage getrennt.
 *   3. Berichtet wird der Gewinn auf Haelfte B, die die Anpassung nie sah.
 *   4. Der Pruefsatz wird hier NICHT angefasst. Er ist die eine Abnahme,
 *      und die faehrt erst, wenn B den Gewinn traegt.
 *
 * Zusaetzlich laeuft eine KONTROLLE mit: dieselbe Zahl Lagen, aber die Fragen
 * werden ZUFAELLIG (Keim 42) auf die Lagen verteilt. Bringt die Kontrolle auf
 * B genauso viel, misst dieser Stand die Zahl der Parameter und nicht die
 * Lage — dann gilt nichts davon.
 *
 * Die Punktzahl wird nicht nachgebaut: `bewerte` kommt aus
 * gewichte-anpassen.ts und ruft die ausgelieferte `bewerteTopf`.
 *
 * Aufruf:
 *   npx tsx src/bench/gewichte-je-lage.ts --merkmale <auszug.jsonl>
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { GEWICHTE } from '../rangfolge.js';
import { EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';
import { bewerte, type Ergebnis } from './gewichte-anpassen.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bZ?: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };
type Einstellung = {
  text: number; thema: number; rueckkopplung: number; seltenheit: number; eingang: number;
};

const AUSLIEFERUNG: Einstellung = {
  text: GEWICHTE.text,
  thema: GEWICHTE.thema,
  rueckkopplung: GEWICHTE.rueckkopplung,
  seltenheit: GEWICHTE.seltenheit,
  eingang: EINGANG_SORTIER_GEWICHT,
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Die Lage einer Frage — nur aus Groessen, die zur Suchzeit vorliegen. */
function lageKennzahlen(z: Zeile): { maxSD: number; maxNT: number } {
  let maxSD = 0;
  let maxNT = -2;
  for (const k of z.topf) {
    if (k.sD > maxSD) maxSD = k.sD;
    if (k.nT > maxNT) maxNT = k.nT;
  }
  return { maxSD, maxNT };
}

function median(werte: number[]): number {
  const s = [...werte].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Koordinatensuche auf EINER Lage.
 *
 * Bewusst grob: vier Achsen, je fuenf Kerben, zwei Durchgaenge. Feiner zu
 * suchen heisst, die Haelfte A genauer auswendig zu lernen — nicht, die
 * Sache besser zu treffen.
 */
function passeAn(zeilen: Zeile[], start: Einstellung): Einstellung {
  const achsen: Array<keyof Einstellung> = ['text', 'seltenheit', 'eingang', 'rueckkopplung'];
  const kerben = [0, 0.25, 0.5, 1, 1.5, 2];
  let beste = { ...start };
  let besteZahl = bewerte(zeilen as never, beste as never).at3;
  for (let runde = 0; runde < 2; runde++) {
    for (const achse of achsen) {
      let lokalBest = beste[achse];
      for (const wert of kerben) {
        const versuch = { ...beste, [achse]: wert };
        const z = bewerte(zeilen as never, versuch as never).at3;
        if (z > besteZahl) { besteZahl = z; lokalBest = wert; }
      }
      beste = { ...beste, [achse]: lokalBest };
    }
  }
  return beste;
}

/**
 * `bewerte` liefert QUOTEN, keine Stueckzahlen (gewichte-anpassen.ts teilt
 * durch n). Wer Quoten aus Teilmengen addiert, bekommt Unsinn — deshalb hier
 * ueberall Anzahl UND Quote, und das Zusammenfassen laeuft ueber die Anzahl.
 */
function zeile(name: string, e: Ergebnis, n: number): string {
  const z = (q: number) => `${String(Math.round(q * n)).padStart(4)} ${(q * 100).toFixed(1).padStart(5)} %`;
  return `${name.padEnd(30)} P1 ${z(e.platz1)}   @3 ${z(e.at3)}   @10 ${z(e.top10)}`;
}

/** Teilergebnisse zu einem Gesamtergebnis buendeln — ueber die ANZAHL. */
function summe(teile: Array<{ e: Ergebnis; n: number }>): { e: Ergebnis; n: number } {
  let p1 = 0; let a3 = 0; let t10 = 0; let n = 0;
  for (const t of teile) {
    p1 += t.e.platz1 * t.n; a3 += t.e.at3 * t.n; t10 += t.e.top10 * t.n; n += t.n;
  }
  return { e: { platz1: p1 / n, at3: a3 / n, top10: t10 / n }, n };
}

/** Anzahl der @3-Treffer aus einer Quote — fuer ehrliche Differenzen. */
function anzahl3(e: Ergebnis, n: number): number { return Math.round(e.at3 * n); }

function keimZufall(keim: number): () => number {
  let s = keim >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

async function main(): Promise<void> {
  const quelle = flag('merkmale');
  if (!quelle) {
    process.stderr.write('Aufruf: --merkmale <auszug.jsonl>\n');
    process.exit(2);
  }
  const zeilen: Zeile[] = [];
  const rl = createInterface({ input: createReadStream(resolve(quelle)) });
  for await (const roh of rl) {
    if (roh.trim()) zeilen.push(JSON.parse(roh) as Zeile);
  }

  // Haelften: gerade/ungerade. Der Satz ist ueber vier Achsen geschichtet,
  // also ist jede zweite Frage eine faire Haelfte.
  const A = zeilen.filter((_, i) => i % 2 === 0);
  const B = zeilen.filter((_, i) => i % 2 === 1);

  // Lagengrenzen aus dem MEDIAN von A — B sieht sie nur angewandt, nie
  // gewaehlt.
  const kennA = A.map(lageKennzahlen);
  const grenzeSD = median(kennA.map((k) => k.maxSD));
  const grenzeNT = median(kennA.map((k) => k.maxNT));
  const lageVon = (z: Zeile): number => {
    const k = lageKennzahlen(z);
    return (k.maxSD >= grenzeSD ? 1 : 0) + (k.maxNT >= grenzeNT ? 2 : 0);
  };
  const NAMEN = ['Wort schwach, Sinn schwach', 'Wort stark, Sinn schwach',
    'Wort schwach, Sinn stark', 'Wort stark, Sinn stark'];

  process.stdout.write(
    `${zeilen.length} Fragen · Haelfte A ${A.length} (Anpassung) · Haelfte B ${B.length} (Abnahme)\n`
    + `Lagengrenzen aus A: maxSD ${grenzeSD.toFixed(3)} · maxNT ${grenzeNT.toFixed(3)}\n\n`,
  );

  // ── Grundlinie: EIN Gewichtssatz, der ausgelieferte ────────────────────
  const grundA = bewerte(A as never, AUSLIEFERUNG as never);
  const grundB = bewerte(B as never, AUSLIEFERUNG as never);
  process.stdout.write(`${zeile('Auslieferung auf A', grundA, A.length)}\n`);
  process.stdout.write(`${zeile('Auslieferung auf B', grundB, B.length)}\n\n`);

  // ── Ein Gewichtssatz, auf A angepasst (die faire Vergleichslinie) ──────
  const einerA = passeAn(A, AUSLIEFERUNG);
  const einerB = bewerte(B as never, einerA as never);
  process.stdout.write(
    `EIN Satz, auf A angepasst: ${JSON.stringify(einerA)}\n`
    + `${zeile('  -> auf B', einerB, B.length)}\n\n`,
  );

  // ── Gewichte je Lage ───────────────────────────────────────────────────
  const teileB: Array<{ e: Ergebnis; n: number }> = [];
  for (let l = 0; l < 4; l++) {
    const aL = A.filter((z) => lageVon(z) === l);
    const bL = B.filter((z) => lageVon(z) === l);
    const e = aL.length >= 50 ? passeAn(aL, AUSLIEFERUNG) : AUSLIEFERUNG;
    const rB = bewerte(bL as never, e as never);
    teileB.push({ e: rB, n: bL.length });
    const rBgrund = bewerte(bL as never, AUSLIEFERUNG as never);
    const d = anzahl3(rB, bL.length) - anzahl3(rBgrund, bL.length);
    process.stdout.write(
      `Lage ${l} — ${NAMEN[l]}  (A ${aL.length}, B ${bL.length})\n`
      + `  Gewichte: ${JSON.stringify(e)}\n`
      + `  auf B: @3 ${anzahl3(rB, bL.length)} von ${bL.length} (${(rB.at3 * 100).toFixed(1)} %)`
      + ` gegen Auslieferung ${anzahl3(rBgrund, bL.length)} (${(rBgrund.at3 * 100).toFixed(1)} %)`
      + `  ${d >= 0 ? '+' : ''}${d}\n`,
    );
  }
  const jeLage = summe(teileB);
  const dGrund = anzahl3(jeLage.e, B.length) - anzahl3(grundB, B.length);
  const dEiner = anzahl3(jeLage.e, B.length) - anzahl3(einerB, B.length);
  process.stdout.write(`\n${zeile('JE LAGE auf B', jeLage.e, B.length)}\n`);
  process.stdout.write(
    `  gegen Auslieferung: @3 ${dGrund >= 0 ? '+' : ''}${dGrund} Antworten`
    + ` · gegen EINEN angepassten Satz: ${dEiner >= 0 ? '+' : ''}${dEiner}\n\n`,
  );

  // ── Die Kontrolle: gleiche Zahl Lagen, zufaellig zugeteilt ─────────────
  const r = keimZufall(42);
  const zufallsLage = new Map<string, number>();
  for (const z of zeilen) zufallsLage.set(z.query, Math.floor(r() * 4));
  const kontrollTeile: Array<{ e: Ergebnis; n: number }> = [];
  for (let l = 0; l < 4; l++) {
    const aL = A.filter((z) => zufallsLage.get(z.query) === l);
    const bL = B.filter((z) => zufallsLage.get(z.query) === l);
    const e = aL.length >= 50 ? passeAn(aL, AUSLIEFERUNG) : AUSLIEFERUNG;
    kontrollTeile.push({ e: bewerte(bL as never, e as never), n: bL.length });
  }
  const kontrollB = summe(kontrollTeile).e;
  const echterGewinn = dGrund;
  const kontrollGewinn = anzahl3(kontrollB, B.length) - anzahl3(grundB, B.length);
  process.stdout.write(
    'KONTROLLE — vier Lagen, aber die Fragen zufaellig zugeteilt (Keim 42).\n'
    + 'Bringt sie auf B genauso viel, misst dieser Stand die Zahl der Parameter,\n'
    + 'nicht die Lage.\n'
    + `${zeile('  Kontrolle auf B', kontrollB, B.length)}\n`
    + `  gegen Auslieferung: @3 ${kontrollGewinn >= 0 ? '+' : ''}${kontrollGewinn} Antworten\n`,
  );
  process.stdout.write(
    `\nURTEIL: echt ${echterGewinn >= 0 ? '+' : ''}${echterGewinn} · Kontrolle ${kontrollGewinn >= 0 ? '+' : ''}${kontrollGewinn}`
    + ` · Unterschied ${echterGewinn - kontrollGewinn >= 0 ? '+' : ''}${echterGewinn - kontrollGewinn} Antworten\n`,
  );
}

main().catch((e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exit(1); });
