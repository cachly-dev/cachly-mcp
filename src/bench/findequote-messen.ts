/**
 * Wie viel von der Decke holt der Sortierer wirklich herunter?
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * decke-messen.ts sagt, ob die richtige Antwort ueberhaupt in der Vorauswahl
 * liegt. Das ist die Obergrenze. Dieses Werkzeug misst, was davon beim Nutzer
 * ankommt: steht sie auch VORNE?
 *
 * Die automatische Einblendung zeigt DREI Lektionen. Findequote@3 ist deshalb
 * die Produktzahl, nicht Platz 1.
 *
 * ── Der Sortierer ist derselbe wie im Auslieferstand ────────────────────────
 *
 * Es wird nichts nachgebaut: `bewerteTopf` und `GEWICHTE` kommen aus
 * src/rangfolge.ts. Wer hier eine zweite Fassung baute, wuerde eine Zahl
 * messen, die es im Produkt nicht gibt.
 *
 * ── Was `--eingang <gewicht>` tut ───────────────────────────────────────────
 *
 * Haengt EIN zusaetzliches Merkmal an den Sortierer: die Naehe zum BESTEN
 * Eingang der Lektion. Damit laesst sich pruefen, ob die Eingaenge in der
 * SORTIERUNG helfen — auch wenn sie in der VORAUSWAHL geschadet haben
 * (gemessen 19.08./20.08.: Vorauswahl mit allen Eingaengen 86 % statt 89 %).
 *
 * Aufruf:
 *   npx tsx src/bench/findequote-messen.ts --korpus <k.json> --pruefsatz <p.json> \
 *     --eingaenge <e.json> --vektoren <v.json> [--tueren name,volltext] [--eingang 0.5]
 *   npx tsx src/bench/findequote-messen.ts --selbstprobe
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keywordSearch } from '../search.js';
import { kosinus, mischeRangfolgen } from '../bedeutung.js';
import {
  Seltenheit, inhaltsWoerter, grobStamm, bewerteTopf, spreizeImTopf,
  reichereAn, GEWICHTE,
} from '../rangfolge.js';
import { mitLektionen } from './mini-redis.js';
import { schluessel } from './eingaenge-einbetten.js';
import type { Eingang } from './eingaenge-b.js';
import type { BenchLesson } from './fixtures.js';

// Der 3000er-Pool (22.08.2026) traegt fuenf Achsen je Frage. Sie sind optional:
// die beiden alten eingefrorenen Saetze haben sie nicht, und die Messung muss
// auf beiden laufen.
interface Frage {
  query: string; relevant: string[]; art?: string;
  guete?: string; form?: string; sprache?: string; tippform?: string; leck?: number;
}
interface Korpus { lessons: BenchLesson[]; queries: Frage[] }
interface Lektionseingaenge { topic: string; eingaenge: Eingang[] }

const PRAEFIX = 'cachly:lesson:best:';

/** Der Platz der besten akzeptablen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function bestePlatzierung(rangfolge: string[], akzeptabel: string[]): number {
  for (const [i, t] of rangfolge.entries()) if (akzeptabel.includes(t)) return i + 1;
  return 0;
}

function fehlt(was: string, pfad: string): never {
  console.error(`NICHT GEMESSEN: ${was} fehlt (${pfad}).`);
  process.exit(2);
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('Platz 1 wird als 1 gemeldet', bestePlatzierung(['a', 'b'], ['a']) === 1);
  p('Platz 2 wird als 2 gemeldet', bestePlatzierung(['a', 'b'], ['b']) === 2);
  p('die BESTE akzeptable zaehlt', bestePlatzierung(['a', 'b', 'c'], ['c', 'b']) === 2);
  p('nicht dabei ist 0', bestePlatzierung(['a', 'b'], ['z']) === 0);
  p('leere Rangfolge ist 0', bestePlatzierung([], ['a']) === 0);

  // Der Sortierer selbst: ein Kandidat, der in ALLEM besser ist, muss vorne stehen.
  const punkte = bewerteTopf([
    { naeheText: 0.2, naeheThema: 0.1, naeheRueckkopplung: 0.2, seltenheitsDeckung: 0.1 },
    { naeheText: 0.9, naeheThema: 0.8, naeheRueckkopplung: 0.9, seltenheitsDeckung: 0.9 },
  ]);
  p('der rundum bessere Kandidat gewinnt', punkte[1] > punkte[0]);

  const s = new Seltenheit(['fail2ban bannt den kanal', 'die platte ist voll', 'die platte ist voll']);
  p('seltenes Wort wiegt mehr als haeufiges', s.wert('fail2ban') > s.wert('platte'));

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
  const POOL = Number(flag('pool') ?? '25');
  const tueren = flag('tueren')?.split(',').map((x) => x.trim()).filter(Boolean);
  const eingangsGewicht = Number(flag('eingang') ?? '0');
  const dreifach = argv.includes('--dreifach');

  // --rrf: den AUSGELIEFERTEN Pfad messen statt des Sortierers aus rangfolge.ts.
  //
  // Das ist keine Feinheit, sondern der Unterschied zwischen zwei Systemen.
  // brain.ts mischt Wortpfad und Bedeutungspfad mit `mischeRangfolgen`
  // (Reciprocal Rank Fusion) und benutzt bewerteTopf gar nicht. Wer die
  // gemessenen +6 Punkte in den Auslieferstand uebernimmt, ohne DIESE
  // Anordnung zu messen, behauptet einen Gewinn an einer Stelle, an der er
  // nie gemessen wurde.
  const rrf = argv.includes('--rrf');

  // --ersetzeText: das Merkmal "Naehe zum ganzen Text" wird durch "Naehe zum
  // BESTEN Eingang" ersetzt, statt es zu ergaenzen.
  //
  // Warum das eine eigene Messung verdient: die Schuldzerlegung vom 20.08.
  // (wo-verliert-der-sortierer.ts) zeigt, dass genau dieses Merkmal in 23 von
  // 37 verlorenen Faellen die FALSCHE Lektion nach vorne holt — mit Abstand
  // der groesste Beitrag (+9,3). Eine 60-Zeichen-Frage gegen 1376 Zeichen Text
  // ist unsymmetrisch; der beste Eingang stellt die Symmetrie her.
  const ersetzeText = argv.includes('--ersetzeText');

  // --gewichte text=1,thema=0.6,... : einzelne Gewichte ueberschreiben.
  const eigeneGewichte = { ...GEWICHTE } as Record<string, number>;
  for (const teil of (flag('gewichte') ?? '').split(',').filter(Boolean)) {
    const [name, wert] = teil.split('=');
    if (name && wert !== undefined && name in eigeneGewichte) eigeneGewichte[name] = Number(wert);
  }

  for (const [was, pfad] of [['Korpus', korpusPfad], ['Pruefsatz', satzPfad],
    ['Eingangsdatei', eingPfad], ['Vektordatei', vekPfad]] as const) {
    if (!existsSync(pfad)) fehlt(was, pfad);
  }

  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as Korpus;
  const { lektionen } = JSON.parse(readFileSync(eingPfad, 'utf8')) as { lektionen: Lektionseingaenge[] };
  const { vektoren } = JSON.parse(readFileSync(vekPfad, 'utf8')) as { vektoren: Record<string, number[]> };
  if (satz.queries.length === 0) fehlt('Fragen im Pruefsatz', satzPfad);

  // --tuerfilter <datei> --schwelle <x>: Tueren unter der Trennschaerfe-Schwelle
  // streichen (Kandidat B, tuer-trennschaerfe.ts). Volltext ausgenommen — er
  // ist zugleich Merkmal (naeheText) und Grundlinie.
  const filterPfad = flag('tuerfilter');
  const schwelle = Number(flag('schwelle') ?? '0');
  const tuerfilter = filterPfad
    ? (JSON.parse(readFileSync(resolve(filterPfad), 'utf8')) as { tueren: Record<string, number> })
    : null;
  let gestrichen = 0;

  const volltextVektor = new Map<string, number[]>();
  const themaVektor = new Map<string, number[]>();
  const tuerVektoren = new Map<string, number[][]>();
  // Tueren ohne Vektor wurden bis zum 22.08.2026 STILL uebersprungen. Was das
  // gekostet hat: ein Messlauf mit 1484 neuen Tueren lieferte Zahlen, die bis
  // auf die letzte Stelle der Grundlinie entsprachen — weil KEINE davon einen
  // Vektor hatte (zwei Einbettungslaeufe hatten dieselbe Ausgabedatei
  // ueberschrieben). Nur weil "identisch" anders aussieht als "keine Wirkung",
  // ist es aufgefallen. Ab jetzt zaehlt und meldet der Lauf es je Tuerart.
  const ohneVektor = new Map<string, number>();
  for (const l of lektionen) {
    const vs: number[][] = [];
    for (const e of l.eingaenge) {
      const key = schluessel(e.art, e.text);
      const v = vektoren[key];
      if (!v) { ohneVektor.set(e.art, (ohneVektor.get(e.art) ?? 0) + 1); continue; }
      if (e.art === 'volltext') volltextVektor.set(l.topic, v);
      if (e.art === 'name') themaVektor.set(l.topic, v);
      if (tuerfilter && e.art !== 'volltext') {
        const w = tuerfilter.tueren[key];
        if (w !== undefined && w < schwelle) { gestrichen++; continue; }
      }
      if (!tueren || tueren.includes(e.art)) vs.push(v);
    }
    tuerVektoren.set(l.topic, vs);
  }

  if (ohneVektor.size > 0) {
    const liste = [...ohneVektor.entries()].sort((a, b) => b[1] - a[1])
      .map(([art, n]) => `${art}=${n}`).join(' ');
    console.error(`WARNUNG: Tueren ohne Vektor werden uebergangen — ${liste}.`
      + ' Die Messung sagt dann nichts ueber sie aus. Erst eingaenge-einbetten.ts fahren.');
  }

  const themen = korpus.lessons.map((l) => l.topic);
  const redis = mitLektionen(korpus.lessons);

  const volltext = (l: BenchLesson): string =>
    [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join(' ');
  const seltenheit = new Seltenheit(korpus.lessons.map(volltext));
  const textWoerter = new Map(korpus.lessons.map(
    (l) => [l.topic, new Set([...inhaltsWoerter(volltext(l))].map(grobStamm))],
  ));

  const plaetze: number[] = [];
  const artPlaetze = new Map<string, number[]>();
  // Je Achse: Wert -> Plaetze. Damit beantwortet EIN Lauf die Frage, der die
  // 100er-Saetze nie gewachsen waren: hilft ein Kandidat bei vagen Fragen und
  // schadet bei praezisen? Bei klein getippten und nicht bei sauberen?
  const achsen = new Map<string, Map<string, number[]>>();

  // --diagnose <datei>: je Frage die Groessen, aus denen ein Unsicherheits-
  // Schalter (Kandidat C1) gebaut werden koennte — am ECHTEN Messweg erhoben,
  // nicht nachgebaut. Eine zweite Fassung dieser Schleife waere eine zweite
  // Wahrheit.
  const diagnosePfad = flag('diagnose');
  const diagnose: Array<Record<string, unknown>> = [];

  for (const q of satz.queries) {
    const fv = vektoren[schluessel('frage', q.query)];
    if (!fv) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);

    const wortListe = (await keywordSearch(redis as never, [`${PRAEFIX}*`], q.query, POOL) as Array<{ key: string }>)
      .map((h) => h.key.replace(PRAEFIX, ''));

    const sinnListe = themen
      .map((t) => {
        const vs = tuerVektoren.get(t) ?? [];
        let best = -2;
        for (const v of vs) { const k = kosinus(fv, v); if (k > best) best = k; }
        return { t, n: best };
      })
      .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t);

    // --dreifach: die Vorauswahl ist die Vereinigung aus DREI Listen statt zwei.
    // Gemessen 20.08.: Eingaenge SCHADEN der Decke (89 % auf 86 %), HELFEN aber
    // der Sortierung (@3 von 52 % auf 56 %). Wer beide Bedeutungslisten
    // nebeneinander stellt, bekommt die Decke der einen und die Ordnung der
    // anderen — es kostet nur ein paar Kandidaten mehr im Topf.
    const volltextListe = dreifach
      ? themen.map((t) => ({ t, n: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2 }))
        .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t)
      : [];
    const topf = [...new Set([...wortListe, ...sinnListe, ...volltextListe])];
    // Rueckkopplung genau wie im Auslieferstand: die Frage mit den besten
    // Treffern anreichern und noch einmal vergleichen.
    const besteDrei = sinnListe.slice(0, 3).map((t) => volltextVektor.get(t)).filter(Boolean) as number[][];
    const angereichert = besteDrei.length ? reichereAn(fv, besteDrei) : fv;

    const besterEingangVon = (t: string): number => {
      const vs = tuerVektoren.get(t) ?? [];
      let best = -2;
      for (const v of vs) { const k = kosinus(fv, v); if (k > best) best = k; }
      return best;
    };

    const fw = inhaltsWoerter(q.query);
    const bewertbar = topf.map((t) => ({
      naeheText: ersetzeText
        ? besterEingangVon(t)
        : (volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2),
      naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
      naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
      seltenheitsDeckung: seltenheit.deckung(fw, textWoerter.get(t) ?? new Set()),
    }));
    let punkte = bewerteTopf(bewertbar, eigeneGewichte as typeof GEWICHTE);

    if (eingangsGewicht > 0) {
      const gespreizt = spreizeImTopf(topf.map(besterEingangVon));
      punkte = punkte.map((p, i) => p + eingangsGewicht * gespreizt[i]);
    }

    const rangfolge = rrf
      // Genau wie brain.ts: Wortliste und Bedeutungsliste ueber die PLATZIERUNG
      // mischen, Gewicht aus bedeutung.ts. Liegt eine Eingangsliste vor, kommt
      // sie als dritte Quelle dazu — nach demselben Verfahren.
      ? (() => {
        const sinnGemischt = eingangsGewicht > 0 && sinnListe.length
          ? mischeRangfolgen(sinnListe, volltextListe.length ? volltextListe : sinnListe, 0.5)
          : sinnListe;
        return mischeRangfolgen(wortListe, sinnGemischt);
      })()
      : topf.map((t, i) => ({ t, p: punkte[i] }))
        .sort((a, b) => b.p - a.p).map((x) => x.t);
    const platz = bestePlatzierung(rangfolge, q.relevant);
    plaetze.push(platz);
    const art = q.art ?? 'ohne';
    if (!artPlaetze.has(art)) artPlaetze.set(art, []);
    artPlaetze.get(art)!.push(platz);

    for (const [achse, wert] of [
      ['guete', q.guete], ['form', q.form], ['sprache', q.sprache],
      ['tippform', q.tippform],
      ['leck', q.leck === undefined ? undefined : (q.leck >= 4 ? 'woertlich' : 'eigene Worte')],
    ] as const) {
      if (wert === undefined) continue;
      if (!achsen.has(achse)) achsen.set(achse, new Map());
      const m = achsen.get(achse)!;
      if (!m.has(wert)) m.set(wert, []);
      m.get(wert)!.push(platz);
    }

    if (diagnosePfad && !rrf) {
      const geordnet = topf.map((t, i) => ({ t, p: punkte[i], i }))
        .sort((a, b) => b.p - a.p);
      const gewinner = geordnet[0];
      diagnose.push({
        query: q.query,
        art,
        platz,
        topf: topf.length,
        bestPunkt: gewinner?.p ?? 0,
        abstand12: geordnet.length > 1 ? geordnet[0].p - geordnet[1].p : 0,
        abstand34: geordnet.length > 3 ? geordnet[2].p - geordnet[3].p : 0,
        deckungGewinner: gewinner ? bewertbar[gewinner.i].seltenheitsDeckung : 0,
        besterEingang: gewinner ? besterEingangVon(gewinner.t) : -2,
      });
    }
  }

  if (diagnosePfad && diagnose.length > 0) {
    writeFileSync(resolve(diagnosePfad), diagnose.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
    console.log(`  Diagnose: ${diagnose.length} Zeilen nach ${resolve(diagnosePfad)}`);
  }

  const quote = (ps: number[], bis: number): string => {
    const n = ps.filter((p) => p > 0 && p <= bis).length;
    return `${n} von ${ps.length} (${Math.round((n / ps.length) * 100)} %)`;
  };
  const mrr = (ps: number[]): string =>
    `${Math.round((ps.reduce((s, p) => s + (p > 0 ? 1 / p : 0), 0) / ps.length) * 1000) / 10} %`;

  console.log('');
  console.log(`  ${korpus.lessons.length} Lektionen · ${plaetze.length} Fragen · Vorauswahl je ${POOL}`
    + (tueren ? ` · Tueren: ${tueren.join(', ')}` : ' · alle Tueren')
    + (eingangsGewicht > 0 ? ` · Merkmal bester Eingang mit Gewicht ${eingangsGewicht}` : '')
    + (dreifach ? ' · DREIFACHE Vorauswahl' : '')
    + (rrf ? ' · AUSGELIEFERTER Pfad (RRF)' : '')
    + (ersetzeText ? ' · Text ERSETZT durch besten Eingang' : '')
    + (flag('gewichte') ? ` · Gewichte ${flag('gewichte')}` : '')
    + (tuerfilter ? ` · Tuerfilter Schwelle ${schwelle}: ${gestrichen} gestrichen` : ''));
  console.log('');
  console.log(`  Platz 1        ${quote(plaetze, 1)}`);
  console.log(`  FINDEQUOTE@3   ${quote(plaetze, 3)}`);
  console.log(`  Top 10         ${quote(plaetze, 10)}`);
  console.log(`  in der Vorauswahl ueberhaupt  ${quote(plaetze, 9999)}`);
  console.log(`  MRR            ${mrr(plaetze)}`);
  console.log('');
  const arten = [...artPlaetze.keys()].sort();
  if (arten.length > 1) {
    console.log('  Nach Art der Frage (Findequote@3):');
    for (const a of arten) console.log(`    ${a.padEnd(14)} ${quote(artPlaetze.get(a)!, 3)}`);
    console.log('');
  }
  // Der Standardfehler je Gruppe: ohne ihn liest man 2 Punkte Unterschied als
  // Wirkung, wo er Rauschen ist. sqrt(p(1-p)/n), in Prozentpunkten.
  const streuung = (ps: number[]): string => {
    const p = ps.filter((x) => x > 0 && x <= 3).length / ps.length;
    return `±${(Math.sqrt((p * (1 - p)) / ps.length) * 100).toFixed(1)}`;
  };
  for (const [achse, m] of achsen) {
    console.log(`  Nach ${achse} (Findequote@3, mit Standardfehler):`);
    for (const w of [...m.keys()].sort()) {
      console.log(`    ${w.padEnd(24)} ${quote(m.get(w)!, 3).padEnd(22)} ${streuung(m.get(w)!)}`);
    }
    console.log('');
  }
  const drin = plaetze.filter((p) => p > 0).length;
  const vorne = plaetze.filter((p) => p > 0 && p <= 3).length;
  console.log(`  Die Vorauswahl enthaelt ${drin} richtige Antworten, vorne landen ${vorne}.`);
  console.log(`  ${drin - vorne} Antworten liegen im Topf und werden nicht gezeigt — das ist der Verlust der SORTIERUNG.`);
}

if (process.argv.includes('--selbstprobe')) selbstprobe();
else void main();
