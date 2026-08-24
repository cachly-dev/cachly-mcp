/**
 * Welches Merkmal drueckt die richtige Antwort nach hinten?
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Gemessen am 20.08.2026: die Vorauswahl enthaelt bei 89 von 100 Fragen eine
 * richtige Antwort, gezeigt werden 52. **37 richtige Antworten liegen im Topf
 * und kommen nie vorne an.** Das ist der groesste einzelne Verlust im ganzen
 * System — groesser als alles, was der Bauplan an der Vorauswahl heben wollte.
 *
 * Zwoelf Sortier-Varianten wurden am 19.08. durchprobiert und brachten je null
 * bis drei Punkte. Weiterprobieren waere die dreizehnte Variante. Dieses
 * Werkzeug fragt stattdessen: WORAN genau verliert die richtige Antwort?
 *
 * ── Wie die Schuld zugewiesen wird ──────────────────────────────────────────
 *
 * Die Punktzahl ist eine Summe gewichteter Merkmale:
 *
 *   Punkte = 1,0·Text + 0,6·Thema + 0,3·Rueckkopplung + 1,3·Seltenheit
 *
 * Steht die falsche Lektion vorne, ist ihr Vorsprung ebenfalls eine Summe:
 *
 *   Vorsprung = Σ Gewicht_i · (Merkmal_i(falsch) − Merkmal_i(richtig))
 *
 * Jeder Summand ist der Beitrag EINES Merkmals zu diesem Vorsprung. Ueber alle
 * verlorenen Fragen aufsummiert ergibt das eine Rangliste: welches Merkmal
 * holt die falschen Lektionen nach vorne.
 *
 * Das ist keine Vermutung ueber die Ursache, sondern eine Zerlegung der Zahl,
 * die tatsaechlich entschieden hat.
 *
 * Aufruf:
 *   npx tsx src/bench/wo-verliert-der-sortierer.ts --korpus <k> --pruefsatz <p> \
 *     --eingaenge <e> --vektoren <v> [--zeige 12]
 *   npx tsx src/bench/wo-verliert-der-sortierer.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import {
  Seltenheit, inhaltsWoerter, grobStamm, bewerteTopf, spreizeImTopf,
  reichereAn, GEWICHTE,
} from '../rangfolge.js';
import { mitLektionen } from './mini-redis.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';
import type { BenchLesson } from './fixtures.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

interface Frage { query: string; relevant: string[]; art?: string }
interface Korpus { lessons: BenchLesson[]; queries: Frage[] }
interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

const PRAEFIX = 'cachly:lesson:best:';
const MERKMALE = ['text', 'thema', 'rueckkopplung', 'seltenheit'] as const;
type Merkmal = typeof MERKMALE[number];

/**
 * Der Beitrag jedes Merkmals zum Vorsprung des Gewinners.
 *
 * Positiv heisst: dieses Merkmal hat dem Gewinner geholfen. Negativ heisst:
 * es sprach fuer die richtige Antwort und wurde ueberstimmt.
 */
export function schuldzerlegung(
  gewinner: Record<Merkmal, number>,
  richtig: Record<Merkmal, number>,
  gewichte: Record<Merkmal, number>,
): Record<Merkmal, number> {
  const aus = {} as Record<Merkmal, number>;
  for (const m of MERKMALE) aus[m] = gewichte[m] * (gewinner[m] - richtig[m]);
  return aus;
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  const g = { text: 1, thema: 0.6, rueckkopplung: 0.3, seltenheit: 1.3 };
  // Konstruiert: der Gewinner ist NUR bei der Seltenheit besser, und zwar um
  // 0,5. Sein Vorsprung muss also 1,3·0,5 = 0,65 sein, alles davon Seltenheit.
  const z = schuldzerlegung(
    { text: 0.4, thema: 0.4, rueckkopplung: 0.4, seltenheit: 0.9 },
    { text: 0.4, thema: 0.4, rueckkopplung: 0.4, seltenheit: 0.4 },
    g,
  );
  p('nur das abweichende Merkmal traegt Schuld',
    Math.abs(z.seltenheit - 0.65) < 1e-9);
  p('gleiche Merkmale tragen keine Schuld',
    z.text === 0 && z.thema === 0 && z.rueckkopplung === 0);

  const z2 = schuldzerlegung(
    { text: 0.2, thema: 0.9, rueckkopplung: 0.5, seltenheit: 0.5 },
    { text: 0.8, thema: 0.1, rueckkopplung: 0.5, seltenheit: 0.5 },
    g,
  );
  p('ein Merkmal fuer die richtige Antwort wird negativ gezaehlt', z2.text < 0);
  p('und das ueberstimmende positiv', z2.thema > 0);
  p('die Summe ist der echte Vorsprung',
    Math.abs((z2.text + z2.thema + z2.rueckkopplung + z2.seltenheit)
      - (1 * (0.2 - 0.8) + 0.6 * (0.9 - 0.1))) < 1e-9);

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const korpusPfad = resolve(flag('korpus') ?? '');
  const satzPfad = resolve(flag('pruefsatz') ?? '');
  const eingPfad = resolve(flag('eingaenge') ?? '');
  const vekPfad = resolve(flag('vektoren') ?? '');
  const POOL = Number(flag('pool') ?? String(SINN_TOPF));
  const zeige = Number(flag('zeige') ?? '10');

  for (const [was, pfad] of [['Korpus', korpusPfad], ['Pruefsatz', satzPfad],
    ['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) fehlt(was, pfad);
  }

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };

  const volltextVektor = new Map<string, number[]>();
  const themaVektor = new Map<string, number[]>();
  for (const l of lektionen) {
    for (const e of l.eingaenge) {
      const v = vektoren[schluessel(e.art, e.text)];
      if (!v) continue;
      if (e.art === 'volltext') volltextVektor.set(l.topic, v);
      if (e.art === 'name') themaVektor.set(l.topic, v);
    }
  }

  const themen = korpus.lessons.map((l) => l.topic);
  const redis = mitLektionen(korpus.lessons);
  const volltext = (l: BenchLesson): string =>
    [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join(' ');
  const seltenheit = new Seltenheit(korpus.lessons.map(volltext));
  const textWoerter = new Map(korpus.lessons.map(
    (l) => [l.topic, new Set([...inhaltsWoerter(volltext(l))].map(grobStamm))],
  ));

  const gewichte: Record<Merkmal, number> = {
    text: GEWICHTE.text, thema: GEWICHTE.thema,
    rueckkopplung: GEWICHTE.rueckkopplung, seltenheit: GEWICHTE.seltenheit,
  };

  const gesamtSchuld = { text: 0, thema: 0, rueckkopplung: 0, seltenheit: 0 } as Record<Merkmal, number>;
  const haeufigsteSchuld = new Map<Merkmal, number>();
  const faelle: Array<{ frage: string; art: string; platz: number; richtig: string; gewinner: string; haupt: Merkmal; vorsprung: number }> = [];
  let imTopf = 0; let vorne = 0; let garNicht = 0;

  for (const q of satz.queries) {
    const fv = vektoren[schluessel('frage', q.query)];
    if (!fv) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);

    const wortListe = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
      .map((h) => h.key.replace(PRAEFIX, ''));
    const sinnListe = themen
      .map((t) => ({ t, n: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2 }))
      .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t);
    const topf = [...new Set([...wortListe, ...sinnListe])];

    const besteDrei = sinnListe.slice(0, 3).map((t) => volltextVektor.get(t)).filter(Boolean) as number[][];
    const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;
    const fw = inhaltsWoerter(q.query);

    const roh = topf.map((t) => ({
      naeheText: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2,
      naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
      naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
      seltenheitsDeckung: seltenheit.deckung(fw, textWoerter.get(t) ?? new Set()),
    }));
    const punkte = bewerteTopf(roh, GEWICHTE);

    // Dieselbe Spreizung wie im Sortierer — sonst passt die Zerlegung nicht
    // zu der Zahl, die tatsaechlich entschieden hat.
    const t = spreizeImTopf(roh.map((k) => k.naeheText));
    const th = spreizeImTopf(roh.map((k) => k.naeheThema));
    const r = spreizeImTopf(roh.map((k) => k.naeheRueckkopplung));
    const werte = topf.map((_, i) => ({
      text: t[i], thema: th[i], rueckkopplung: r[i], seltenheit: roh[i].seltenheitsDeckung,
    }));

    const rang = topf.map((tp, i) => ({ tp, p: punkte[i], i }))
      .sort((a, b) => b.p - a.p);
    const platz = rang.findIndex((x) => q.relevant.includes(x.tp)) + 1;

    if (platz === 0) { garNicht++; continue; }
    imTopf++;
    if (platz <= 3) { vorne++; continue; }

    const richtigIdx = rang[platz - 1].i;
    const gewinnerIdx = rang[0].i;
    const z = schuldzerlegung(werte[gewinnerIdx], werte[richtigIdx], gewichte);
    let haupt: Merkmal = 'text';
    for (const m of MERKMALE) if (z[m] > z[haupt]) haupt = m;
    for (const m of MERKMALE) gesamtSchuld[m] += z[m];
    haeufigsteSchuld.set(haupt, (haeufigsteSchuld.get(haupt) ?? 0) + 1);

    faelle.push({
      frage: q.query, art: q.art ?? 'ohne', platz,
      richtig: rang[platz - 1].tp, gewinner: rang[0].tp, haupt,
      vorsprung: rang[0].p - rang[platz - 1].p,
    });
  }

  console.log('');
  console.log(`  ${satz.queries.length} Fragen · ${imTopf} mit richtiger Antwort im Topf · ${vorne} davon vorne · ${garNicht} gar nicht drin`);
  console.log(`  ${faelle.length} Faelle liegen im Topf und werden NICHT gezeigt. Nur um die geht es hier.`);
  console.log('');
  console.log('  WELCHES MERKMAL HOLT DIE FALSCHE LEKTION NACH VORNE?');
  console.log('  (Summe der Beitraege zum Vorsprung des Gewinners; negativ = sprach fuer die richtige)');
  const sortiert = MERKMALE.slice().sort((a, b) => gesamtSchuld[b] - gesamtSchuld[a]);
  for (const m of sortiert) {
    const anteilFaelle = haeufigsteSchuld.get(m) ?? 0;
    console.log(`    ${m.padEnd(16)} ${gesamtSchuld[m] >= 0 ? '+' : ''}${gesamtSchuld[m].toFixed(1).padStart(6)}`
      + `   Hauptschuld in ${anteilFaelle} von ${faelle.length} Faellen`);
  }
  console.log('');

  const nachArt = new Map<string, number>();
  for (const f of faelle) nachArt.set(f.art, (nachArt.get(f.art) ?? 0) + 1);
  console.log('  Verlorene Faelle nach Art der Frage:',
    [...nachArt.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}=${n}`).join(' '));
  console.log('');

  console.log(`  Die ${Math.min(zeige, faelle.length)} knappsten Faelle (kleiner Vorsprung = fast gewonnen):`);
  for (const f of faelle.slice().sort((a, b) => a.vorsprung - b.vorsprung).slice(0, zeige)) {
    console.log(`    Platz ${String(f.platz).padStart(2)} · Abstand ${f.vorsprung.toFixed(2)} · ${f.haupt}`);
    console.log(`      Frage:    ${f.frage.slice(0, 80)}`);
    console.log(`      richtig:  ${f.richtig}`);
    console.log(`      gewinner: ${f.gewinner}`);
  }
}

if (process.argv.includes('--selbstprobe')) selbstprobe();
else void main();
