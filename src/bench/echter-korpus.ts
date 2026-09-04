/**
 * Der Messstand — 499 echte Lektionen, 100 von Hand geschriebene Fragen.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Bis zum 20.08.2026 hiess `npm run bench` etwas anderes: 17 Lektionen,
 * 13 Fragen, erfundener Beispielsatz. Dieser Messstand hat die beiden
 * Rangfolge-Formeln GENAU VERKEHRT HERUM einsortiert — 92,3 gegen 69,2 Prozent
 * fuer die Fassung, die auf 498 echten Lektionen 15 statt 30 Prozent erreichte.
 *
 * Er hat damit nicht nur nichts bewiesen. Er haette die Verschlechterung
 * belohnt, wenn jemand ihn ernst genommen haette. Am selben Tag stand in der
 * Ausgabe des Servers eine fest eingebaute Zeichenkette "+33,3 % Precision@1",
 * bewacht von einem Test, der genau diese Zeichenkette verlangte.
 *
 * ── Was dieser hier anders macht ────────────────────────────────────────────
 *
 * 1. Der Bestand ist echt: 499 Lektionen aus einem gewachsenen Speicher, mit
 *    allen Ablenkern, die dort stehen.
 * 2. Die Fragen hat ein Mensch geschrieben, ohne die Lektion abzuschreiben.
 *    Sonst misst der Messstand seine eigene Formulierung.
 * 3. Die Vektoren sind die ECHTEN — aus dem laufenden Speicher eingefroren,
 *    nicht neu berechnet.
 * 4. Die Rechnung ist die AUSGELIEFERTE. Sie steht in auswertung.ts und wird
 *    mit dem Lauf am echten Bestand geteilt. Zwei Rechnungen waeren zwei
 *    Wahrheiten.
 *
 * ── Was er nicht kann ───────────────────────────────────────────────────────
 *
 * Er ist eingefroren. Ein Bestand, der waechst, bekommt neue Ablenker; dieser
 * hier nicht. Die Zahl ist also eher zu gut als zu schlecht, und sie altert.
 * `korpus-einfrieren.ts` erneuert ihn.
 *
 * Aufruf:  npm run bench
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MiniRedis } from './mini-redis.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { entpacke } from '../bedeutung.js';
import { messe, quote, type Frage } from './auswertung.js';
import {
  SINN_TOPF,
  EINGANG_SCHWELLE,
  EINGANG_SORTIER_GEWICHT,
} from '../rangfolge-stellschrauben.js';

interface Lektion { topic: string; [k: string]: unknown }
export interface Korpus { lektionen: Lektion[]; fragen: Frage[] }
export interface Vektoren {
  volltext: Record<string, string>;
  name: Record<string, string>;
  eingaenge: Record<string, Record<string, string>>;
  fragen: Record<string, string>;
}

/**
 * Die Untergrenzen.
 *
 * Sie stehen als ZAHLEN da und nicht als "nicht schlechter als gestern", weil
 * ein gleitender Vergleich jede langsame Verschlechterung durchlaesst. Wer sie
 * senkt, muss es hier tun — sichtbar, in einem Commit, mit Begruendung.
 *
 * Stand 20.08.2026, gemessen am echten Speicher mit denselben 100 Fragen:
 * Platz 1 = 37 %, Findequote@3 = 53 %, Top 10 = 70 %, im Topf = 88 %.
 * Die Grenzen liegen bewusst knapp darunter — sie sollen einen Einbruch
 * fangen, nicht eine Nachkommastelle bewachen.
 */
export const UNTERGRENZEN = {
  // Dreimal angehoben am 21.08.2026, jede Stufe einzeln gemessen:
  //
  //   Stand                                Platz 1    @3    Top 10   im Topf
  //   Ausgangslage                           37,0    52,0    70,0     86,0
  //   (a) Tueren ganz raus                   39,0    51,0    71,0     90,0
  //   (b) Topf 25 -> 75                      38,0    53,0    71,0     97,0
  //   (c) Tueren zurueck, MIT Schwelle       40,0    55,0    72,0     97,0
  //
  // (c) ist die Korrektur an (a): nicht die Tueren waren falsch, sondern ihre
  // Verrechnung. spreizeImTopf gibt einem fehlenden Wert eine NULL, also den
  // schlechtesten Wert — die 108 Lektionen ohne Fehlertext bekamen dadurch
  // systematisch Abzug. Mit Schwelle zaehlt die Tuer nur, wo sie etwas
  // aussagt. Kreuzweise geprueft: 41 gegen 38 Prozent auf Platz 1.
  //
  // Die Grenzen liegen knapp darunter — sie fangen einen Einbruch, keine
  // Nachkommastelle. Wer sie senkt, tut es hier, sichtbar, mit Begruendung.
  //
  // imTopf ist die wichtigste: sie ist die Decke jeder kuenftigen Sortierung.
  // Faellt sie, ist ein Kanal kaputt — und das merkt man an Platz 1 erst
  // Wochen spaeter.
  platz1: 0.36,
  findequote3: 0.50,
  top10: 0.66,
  imTopf: 0.92,
  /** Der Bedeutungsabgleich muss den reinen Wortabgleich schlagen. Sonst ist er nur teuer. */
  vorsprungGegenWorteFindequote3: 0.05,
};

/** Baut den Speicher-Ersatz aus dem eingefrorenen Korpus. */
export function baueBestand(korpus: Korpus, v: Vektoren): MiniRedis {
  const r = new MiniRedis();
  for (const l of korpus.lektionen) r.set(`cachly:lesson:best:${l.topic}`, JSON.stringify(l));
  for (const [topic, gepackt] of Object.entries(v.volltext)) r.set(`cachly:lesson:vec:${topic}`, gepackt);
  for (const [topic, gepackt] of Object.entries(v.name)) r.set(`${NAME_VEKTOR_PRAEFIX}${topic}`, gepackt);
  for (const [topic, tueren] of Object.entries(v.eingaenge)) {
    const felder: string[] = [];
    for (const [text, gepackt] of Object.entries(tueren)) felder.push(text, gepackt);
    if (felder.length > 0) r.hset(`cachly:lesson:eing:${topic}`, ...felder);
  }
  return r;
}

const prozent = (x: number): string => `${(x * 100).toFixed(1).padStart(5)} %`;

async function main(): Promise<void> {
  const hier = dirname(fileURLToPath(import.meta.url));
  // --korpus zeigt auf einen ANDEREN Fragensatz bei denselben Lektionen.
  // Gebraucht fuer die Gegenprobe: ein Gewinn auf EINEM Fragensatz ist eine
  // Eigenschaft des Satzes, nicht des Verfahrens (Beleg 19.08.2026, die alte
  // Rangfolge-Formel gewann nur auf dem Satz, an dem sie gefunden wurde).
  const ki = process.argv.indexOf('--korpus');
  const kDatei = ki > -1 ? process.argv[ki + 1] : join(hier, 'korpus', 'korpus.json');
  const korpus = JSON.parse(readFileSync(kDatei, 'utf8')) as Korpus;
  if (ki > -1) console.log(`\n  Korpus aus:   ${kDatei}`);
  // --vektoren zeigt auf eine ANDERE Vektordatei, Vorgabe bleibt die
  // eingefrorene. Gebraucht, um einen Umbau (z.B. die Fragewolken) gegen
  // dieselben Untergrenzen zu halten, BEVOR er in den Korpus wandert. Ohne den
  // Schalter muesste man die eingefrorene Datei tauschen — und wer das
  // vergisst, misst danach den Umbau als Ausgangslage.
  const i = process.argv.indexOf('--vektoren');
  const vDatei = i > -1 ? process.argv[i + 1] : join(hier, 'korpus', 'korpus-vektoren.json');
  const v = JSON.parse(readFileSync(vDatei, 'utf8')) as Vektoren;
  if (i > -1) console.log(`\n  Vektoren aus: ${vDatei}`);

  const redis = baueBestand(korpus, v);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);

  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };

  // --zweitvektoren: ein ZWEITES Embedding als siebtes Sortier-Merkmal messen
  // (Karte cgf6kcyrg02s; auf Einstell- und Pruefsatz bestaetigt: +79/+74 @3,
  // VORREGISTRIERUNG-zweitembedding.md). Die Datei traegt ROHE Vektoren je
  // Lektion (volltext[topic]) und Frage (fragen[query]).
  //
  // Der Kniff mit `aktuelleZweitFrage`: zusatzMerkmal.werte bekommt nur den
  // bge-Fragevektor, das Zweitmerkmal braucht aber den qwen-Vektor DERSELBEN
  // Frage. messe() ruft frageVektor je Frage genau einmal und verarbeitet
  // die Fragen nacheinander — der Seitenkanal ist deshalb eindeutig.
  const zi = process.argv.indexOf('--zweitvektoren');
  const zweit = zi > -1
    ? JSON.parse(readFileSync(process.argv[zi + 1], 'utf8')) as {
      volltext: Record<string, number[]>; fragen: Record<string, number[]>;
    }
    : null;
  if (zweit) console.log(`\n  Zweitvektoren: ${process.argv[zi + 1]} (Merkmal aktiv, Gewicht 1.0)`);
  let aktuelleZweitFrage: number[] | null = null;
  const zweitKosinus = (a: number[], b: number[]): number => {
    let s = 0; let na = 0; let nb = 0;
    for (let k = 0; k < a.length; k++) { s += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
    const nenner = Math.sqrt(na) * Math.sqrt(nb);
    return nenner > 0 ? s / nenner : -2;
  };

  const frageVektor = (q: Frage): number[] | null => {
    if (zweit) aktuelleZweitFrage = zweit.fragen[q.query] ?? null;
    const gepackt = v.fragen[q.query];
    return gepackt ? entpacke(gepackt) : null;
  };

  console.log('');
  console.log('🧠  Cachly-Messstand — am echten Bestand');
  console.log('──────────────────────────────────────────────────────────────────────');
  /*
   * ── Das Alter des Korpus steht im Kopf (Karte tupujdmpjk0q) ─────────────
   *
   * "Gemessen am echten Bestand" gilt fuer den Bestand des Einfrier-Tags.
   * Ohne Datum misst die Zahl irgendwann eine Vergangenheit, und nichts
   * sagt es — die Fehlerklasse des alten Messstands. Quelle: das Feld
   * erzeugt_am (neue Korpusse), sonst das letzte git-Datum der Datei,
   * sonst ausdruecklich UNBEKANNT (der dritte Ausgang, keine stille 0).
   */
  const erzeugtAm = (korpus as { erzeugt_am?: string }).erzeugt_am ?? (() => {
    try {
      return execFileSync('git', ['log', '-1', '--format=%cI', '--', kDatei],
        { encoding: 'utf8', timeout: 10_000 }).trim() || null;
    } catch { return null; }
  })();
  if (erzeugtAm) {
    const alterTage = Math.floor((Date.now() - new Date(erzeugtAm).getTime()) / 86_400_000);
    console.log(`  Korpus eingefroren am ${erzeugtAm.slice(0, 10)} — ${alterTage} Tage alt`);
    if (alterTage > 90) {
      console.log('  ⚠️  AELTER ALS 90 TAGE: die Zahlen beschreiben den Bestand von damals.');
      console.log('     Erneuern: npx tsx src/bench/korpus-aus-brain.ts + korpus-einfrieren.ts');
    }
  } else {
    console.log('  ⚠️  Korpus-Alter UNBEKANNT (kein erzeugt_am, kein git-Datum) — Frische unbewiesen.');
  }
  console.log(`  Lektionen ${korpus.lektionen.length} · Fragen ${korpus.fragen.length} · Vektoren ${vektorbestand.groesse} Volltext / ${namensbestand.groesse} Namen / ${eingangsbestand.anzahlEingaenge} Eingaenge`);

  if (vektorbestand.groesse === 0) {
    console.error('NICHT GEMESSEN: kein einziger Volltextvektor — der Bedeutungsabgleich waere aus.');
    process.exit(3);
  }

  const worte = await messe(redis, korpus.fragen, frageVektor, bestaende, { nurWorte: true, pool: SINN_TOPF });
  // `{}` misst das PRODUKTIONSVERHALTEN — seit dem 21.08.2026 ohne die
  // Fehlertext-Tueren (Messung und Begruendung: Optionen.eingaenge in
  // auswertung.ts und src/bench/tueren-vergleich.ts). Die Spalte "mit Tueren"
  // bleibt in der Tabelle, damit sichtbar ist, was der Ausbau gebracht hat —
  // und damit auffaellt, wenn sich das Verhaeltnis je wieder dreht.
  // POOL muss der Produktion entsprechen (SINN_TOPF in handlers/brain.ts).
  // Ein Messstand mit anderem Topf misst eine andere Suchmaschine.
  const POOL = SINN_TOPF;
  // Produktionsverhalten seit 21.08.2026: die Fehlertext-Tuer NOMINIERT nicht
  // (sie hat die richtige Antwort fuenfmal aus dem Topf gedraengt), sortiert
  // aber MIT SCHWELLE mit. Beides gemessen: tueren-vergleich.ts und
  // schwelle-abtasten.ts. Der Bench muss das spiegeln, sonst misst er eine
  // andere Suchmaschine als die ausgelieferte.
  // Kein eigener Wert mehr: er kommt aus derselben Datei wie im
  // ausgelieferten Pfad (rangfolge-stellschrauben.ts).
  // EIN Tuer-Merkmal, nicht zwei. Ein zweites (der Mittelwert ueber alle
  // Tueren) wurde am 21.08.2026 abgetastet und NICHT eingebaut, weil er auf
  // dem heutigen Speicher schadet — Begruendung mit Zahlen in handlers/brain.ts
  // ueber dem Tuer-Block. Wer ihn hier aufnimmt, ohne ihn dort einzubauen,
  // misst wieder eine andere Suchmaschine als die ausgelieferte.
  const tuerMerkmal = {
    werte: (fv: number[], topic: string) => {
      const n = eingangsbestand.besteNaehe(fv, topic);
      return n >= EINGANG_SCHWELLE ? n : -2;
    },
    gewicht: EINGANG_SORTIER_GEWICHT,
  };
  const zweitMerkmal = zweit
    ? {
      werte: (_fv: number[], topic: string) => {
        const vt = zweit.volltext[topic];
        return aktuelleZweitFrage && vt ? zweitKosinus(aktuelleZweitFrage, vt) : -2;
      },
      gewicht: 1.0,
    }
    : null;
  const voll = await messe(redis, korpus.fragen, frageVektor, bestaende, {
    pool: POOL,
    zusatzMerkmal: zweitMerkmal ? [tuerMerkmal, zweitMerkmal] : tuerMerkmal,
  });
  const mitTueren = await messe(redis, korpus.fragen, frageVektor, bestaende, { eingaenge: 'voll', pool: POOL });

  if (voll.plaetze.length === 0) {
    console.error('NICHT GEMESSEN: keine einzige Frage hatte einen Vektor.');
    process.exit(4);
  }
  if (voll.ohneFragevektor > 0) {
    console.error(`WARNUNG: ${voll.ohneFragevektor} Fragen ohne Vektor uebersprungen.`);
  }

  console.log('');
  console.log('  Kennzahl        nur Worte   mit Tueren    cachly     Vorsprung');
  const zeile = (name: string, bis: number): void => {
    const w = quote(worte.plaetze, bis);
    const o = quote(mitTueren.plaetze, bis);
    const c = quote(voll.plaetze, bis);
    const d = c - w;
    console.log(`  ${name.padEnd(14)} ${prozent(w)}     ${prozent(o)}   ${prozent(c)}    ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} Pkt`);
  };
  zeile('Platz 1', 1);
  zeile('Findequote@3', 3);
  zeile('Top 10', 10);
  zeile('im Topf', 99999);

  console.log('──────────────────────────────────────────────────────────────────────');

  const arten = [...voll.artPlaetze.keys()].sort();
  if (arten.length > 1) {
    console.log('  Nach Art der Frage (Findequote@3):');
    for (const a of arten) {
      const ps = voll.artPlaetze.get(a)!;
      console.log(`    ${a.padEnd(14)} ${prozent(quote(ps, 3))}  (${ps.length} Fragen)`);
    }
    console.log('');
  }

  // Untergrenzen. Sie sind der eigentliche Zweck: eine Zahl, die fallen kann.
  const g = UNTERGRENZEN;
  const pruefungen: Array<[string, number, number]> = [
    ['Platz 1', quote(voll.plaetze, 1), g.platz1],
    ['Findequote@3', quote(voll.plaetze, 3), g.findequote3],
    ['Top 10', quote(voll.plaetze, 10), g.top10],
    ['im Topf', quote(voll.plaetze, 99999), g.imTopf],
    ['Vorsprung@3 gegen Worte', quote(voll.plaetze, 3) - quote(worte.plaetze, 3), g.vorsprungGegenWorteFindequote3],
  ];
  let rot = 0;
  for (const [was, ist, soll] of pruefungen) {
    if (ist < soll) {
      console.error(`  ROT: ${was} ${prozent(ist)} liegt unter der Untergrenze ${prozent(soll)}`);
      rot++;
    }
  }
  if (rot > 0) {
    console.error('');
    console.error(`  ${rot} Untergrenze(n) gerissen.`);
    process.exit(1);
  }
  console.log('  Alle Untergrenzen gehalten.');
  console.log('');
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/echter-korpus.ts');
if (direktGestartet) main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
