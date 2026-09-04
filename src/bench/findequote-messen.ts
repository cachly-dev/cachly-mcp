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

import { readFileSync, existsSync, createWriteStream, writeFileSync } from 'node:fs';
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
import { SINN_TOPF, EINGANG_SCHWELLE, EINGANG_SORTIER_GEWICHT } from '../rangfolge-stellschrauben.js';

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
  // Vorgabe aus dem Auslieferstand, NICHT aus einer Zahl hier. Bis zum
  // 24.08.2026 stand hier 25, waehrend das Produkt mit 75 sucht — jede
  // Messung ohne ausdrueckliches --pool mass damit eine Suchmaschine mit
  // einem Drittel der Kandidaten. Genau die Fehlerklasse, gegen die
  // rangfolge-stellschrauben.ts gebaut wurde.
  const POOL = Number(flag('pool') ?? String(SINN_TOPF));
  // Getrennte Kanal-Tiefen wie in decke-messen.ts (Karte 3utwghaycu3g):
  // das Produkt sucht mit wortpool 25 und sinnpool 75 — ohne die Flags
  // bleibt ALLES beim alten POOL-Verhalten.
  const WORTPOOL = Number(flag('wortpool') ?? String(POOL));
  const SINNPOOL = Number(flag('sinnpool') ?? String(POOL));
  /*
   * ── --seltenheit <n>: der dritte Nominierungskanal ──────────────────────
   *
   * Naturworkshop 2 (23.08.2026, Oekologe und Verhaltensoekologe unabhaengig):
   * die Seltenheitsdeckung traegt das hoechste Sortiergewicht (1,3) und kann
   * niemanden in den Topf holen — sie wird nur fuer Kandidaten gerechnet,
   * die schon drin sind. Ein Baufehler, kein Gewichtsproblem.
   *
   * Gemessen dort: POOL 50 + Seltenheit 25 = 95,0 % Decke bei 81 Kandidaten,
   * gegen groessengleiche Gegenprobe POOL 60 = 93,0 % bei 78. Bei den vier
   * Fragen jenseits von Bedeutungsplatz 200 findet Seltenheit 3 von 4.
   *
   * UND DIE WARNUNG aus derselben Messung: Decke ist nicht Produkt. Reine
   * Topfvergroesserung 25 -> 150 hob die Decke um neun Punkte und die
   * Findequote@3 um zwei. Deshalb steht der Kanal HIER als Schalter und
   * nicht im Auslieferstand: erst wenn die FINDEQUOTE ihn rechtfertigt,
   * wird er Produktvorgabe.
   *
   * Vorgabe 0: keine eingefrorene Messung verschiebt sich still.
   *
   * ── DAS URTEIL (30.08.2026, vorregistrierter A/B-Lauf, 4000 Fragen) ────
   *
   * A (seltenheit 0): Platz 1 39 % · @3 52 % · Decke 79 % (3174).
   * B (seltenheit 25): Platz 1 +1 Antwort · @3 −3 · Decke 81 % (+61).
   *
   * Die Vorregistrierung verlangte Decke +2 Punkte UND steigende @3 —
   * beides verfehlt. Der Kanal hebt die Decke um 1,5 Punkte, die
   * Sortierung setzt KEINEN der zusaetzlichen Kandidaten nach vorne um.
   * ER WIRD NICHT PRODUKTVORGABE. Die Kleinmessung oben (POOL50+25) hat
   * sich bei 4000 Fragen nicht bestaetigt — Kleinstichproben-Warnung.
   *
   * Der eigentliche Befund: 1089 richtige Antworten lagen im Topf und
   * wurden nicht gezeigt. Der Engpass ist die SORTIERUNG, nicht die
   * Nominierung. Karte f6ytkd1254lh.
   */
  const seltenheitTopf = Number(flag('seltenheit') ?? '0');
  const tueren = flag('tueren')?.split(',').map((x) => x.trim()).filter(Boolean);
  // Standard = die AUSGELIEFERTE Maschine (rangfolge-stellschrauben.ts).
  // Bis 01.09.2026 war der Standard 0 — jede Messung ohne --eingang beschrieb
  // damit eine Sortierung OHNE das Tuer-Merkmal, das brain.ts seit dem
  // 23.08. mitsortiert (Lauffamilie, Kontobuch, Anatomie der 884 inklusive).
  // Wer die alte Welt will, sagt es jetzt ausdruecklich: --eingang 0.
  const eingangsGewicht = Number(flag('eingang') ?? String(EINGANG_SORTIER_GEWICHT));
  // Optionaler Merkmals-Auszug fuer den Gewichts-Anpasser.
  const merkmalPfad = flag('merkmale-nach');
  const merkmalStrom = merkmalPfad ? createWriteStream(resolve(merkmalPfad)) : null;
  const dreifach = argv.includes('--dreifach');

  // --rrf: den ALTEN Auslieferpfad messen (mischeRangfolgen, bis 20.08.2026).
  //
  // VERALTET SEIT 20.08.2026: brain.ts sortiert seither selbst mit
  // bewerteTopf (+ Tuer-Merkmal mit Schwelle seit 23.08.). Dieser Schalter
  // bleibt als Vergleichsanker: am 01.09.2026 gemessen kostet RRF auf dem
  // Einstellsatz 181 @3-Antworten (1706 statt 1887) — das ist der Wert, den
  // der 20.08.-Umbau geholt hat. Wer diesen Kommentar liest, weil er wissen
  // will, was ausliefert: brain.ts ab "Die Sortierung", und die geteilten
  // Zahlen stehen in rangfolge-stellschrauben.ts.
  const rrf = argv.includes('--rrf');

  // --zweitvektoren: ein ZWEITES Embedding als Sortier-Signal messen
  // (VORREGISTRIERUNG-zweitembedding.md). Der Topf bleibt unberuehrt —
  // das Zweitmodell bewertet nur, es nominiert nie (Koopman-Sperre).
  // --zweitgewicht: Gewicht des sechsten Merkmals (additiv, gespreizt).
  // --zweitersatz: statt additiv ersetzt naeheZweit das Merkmal naeheText.
  const zweitPfad = flag('zweitvektoren');
  const zweitGewicht = Number(flag('zweitgewicht') ?? '1');
  const zweitErsatz = argv.includes('--zweitersatz');

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
  const zweit = zweitPfad
    ? (JSON.parse(readFileSync(resolve(zweitPfad), 'utf8')) as { vektoren: Record<string, number[]> }).vektoren
    : null;
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
  const volltextZweit = new Map<string, number[]>();
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
      if (zweit && e.art === 'volltext') {
        const v2 = zweit[key];
        if (v2) volltextZweit.set(l.topic, v2);
      }
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

  /*
   * ── --kontobuch <datei>: das Verlust-Kontobuch (Karte 3utwghaycu3g) ─────
   *
   * Elf Altmeister-Funde verlangen dieselbe Vorarbeit: je FRAGE der volle
   * Wort- und Sinn-Rang der richtigen Lektion (nicht nur drin/nicht drin),
   * die gemeinsamen seltenen Staemme, die Tuer-Naehe und die Achsen.
   * Klassengrenzen: VORREGISTRIERUNG-kontobuch.md im Altmeister-Laufordner
   * (Grenze 200, vorab gewaehlt). Am ECHTEN Messweg erhoben — eine zweite
   * Fassung dieser Schleife waere eine zweite Wahrheit.
   */
  const kontobuchPfad = flag('kontobuch');
  const kontobuch: Array<Record<string, unknown>> = [];
  const KLASSENGRENZE = 200;
  // Dokumenthaeufigkeit je Stamm, einmal ueber den Bestand — fuer die
  // df<=2-Zaehlung (Kryptograph F2). Nur im Kontobuch-Modus gerechnet.
  const dfJeStamm = new Map<string, number>();
  if (kontobuchPfad) {
    for (const ws of textWoerter.values()) {
      for (const w of ws) dfJeStamm.set(w, (dfJeStamm.get(w) ?? 0) + 1);
    }
  }

  for (const q of satz.queries) {
    const fv = vektoren[schluessel('frage', q.query)];
    if (!fv) fehlt(`Vektor fuer "${q.query.slice(0, 40)}"`, vekPfad);
    const fv2 = zweit ? zweit[schluessel('frage', q.query)] : null;
    if (zweit && !fv2) fehlt(`Zweitvektor fuer "${q.query.slice(0, 40)}"`, String(zweitPfad));

    // Im Kontobuch-Modus wird die VOLLE Wort-Rangfolge geholt und fuer den
    // Topf auf WORTPOOL geschnitten — derselbe Suchweg, ein Aufruf.
    const wortVoll = (await keywordSearch(
      redis as never, [`${PRAEFIX}*`], q.query, kontobuchPfad ? themen.length : WORTPOOL,
    ) as Array<{ key: string }>).map((h) => h.key.replace(PRAEFIX, ''));
    const wortListe = wortVoll.slice(0, WORTPOOL);

    // Frageworte einmal je Frage — Nominierung und Sortierung lesen dieselbe
    // Menge. Zwei Zerlegungen waeren zwei Wahrheiten.
    const fw = inhaltsWoerter(q.query);

    // Der dritte Kanal: wer die seltenen Frageworte deckt, kommt in den
    // Topf — unabhaengig davon, wo sein Vektor liegt. Genau die Faelle
    // jenseits von Bedeutungsplatz 200, die kein anderer Kanal erreicht.
    const seltenheitListe = seltenheitTopf > 0
      ? themen
        .map((t) => ({ t, d: seltenheit.deckung(fw, textWoerter.get(t) ?? new Set()) }))
        .filter((x) => x.d > 0)
        .sort((a, b) => b.d - a.d)
        .slice(0, seltenheitTopf)
        .map((x) => x.t)
      : [];

    const sinnVoll = themen
      .map((t) => {
        const vs = tuerVektoren.get(t) ?? [];
        let best = -2;
        for (const v of vs) { const k = kosinus(fv, v); if (k > best) best = k; }
        return { t, n: best };
      })
      .sort((a, b) => b.n - a.n);
    const sinnListe = sinnVoll.slice(0, SINNPOOL).map((x) => x.t);

    // --dreifach: die Vorauswahl ist die Vereinigung aus DREI Listen statt zwei.
    // Gemessen 20.08.: Eingaenge SCHADEN der Decke (89 % auf 86 %), HELFEN aber
    // der Sortierung (@3 von 52 % auf 56 %). Wer beide Bedeutungslisten
    // nebeneinander stellt, bekommt die Decke der einen und die Ordnung der
    // anderen — es kostet nur ein paar Kandidaten mehr im Topf.
    const volltextListe = dreifach
      ? themen.map((t) => ({ t, n: volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2 }))
        .sort((a, b) => b.n - a.n).slice(0, POOL).map((x) => x.t)
      : [];
    const topf = [...new Set([...wortListe, ...sinnListe, ...volltextListe, ...seltenheitListe])];
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

    const bewertbar = topf.map((t) => ({
      naeheText: zweitErsatz
        ? (fv2 && volltextZweit.has(t) ? kosinus(fv2, volltextZweit.get(t)!) : -2)
        : ersetzeText
          ? besterEingangVon(t)
          : (volltextVektor.has(t) ? kosinus(fv, volltextVektor.get(t)!) : -2),
      naeheThema: themaVektor.has(t) ? kosinus(fv, themaVektor.get(t)!) : -2,
      naeheRueckkopplung: volltextVektor.has(t) ? kosinus(angereichert, volltextVektor.get(t)!) : -2,
      seltenheitsDeckung: seltenheit.deckung(fw, textWoerter.get(t) ?? new Set()),
      // Naturworkshop 3: das Maximum der Wort-Seltenheit, nicht der Anteil.
      besterZeuge: seltenheit.besterZeuge(fw, textWoerter.get(t) ?? new Set()),
    }));
    let punkte = bewerteTopf(bewertbar, eigeneGewichte as typeof GEWICHTE);

    // Das sechste Merkmal: Naehe im Zweitmodell, additiv und gespreizt wie
    // das Tuer-Merkmal. Fehlender Vektor = -2 ("kein Wert"), nie Abzug.
    if (zweit && !zweitErsatz) {
      const naehen = topf.map((t) => (fv2 && volltextZweit.has(t) ? kosinus(fv2, volltextZweit.get(t)!) : -2));
      const gespreizt = spreizeImTopf(naehen);
      punkte = punkte.map((p, i) => p + zweitGewicht * gespreizt[i]);
    }

    if (eingangsGewicht > 0) {
      // Exakt wie brain.ts: unterhalb der Schwelle meldet das Merkmal -2
      // ("kein Wert"), nicht einen schlechten Wert — sonst bekaemen
      // Lektionen ohne Fehlertext systematisch Abzug. Bis 01.09.2026 fehlte
      // die Schwelle hier; der Bench mass damit ein Merkmal, das im Produkt
      // so nie sortiert hat.
      const naehen = topf.map((t) => {
        const n = besterEingangVon(t);
        return n >= EINGANG_SCHWELLE ? n : -2;
      });
      const gespreizt = spreizeImTopf(naehen);
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
    if (merkmalStrom) {
      /*
       * ── Warum die Merkmale ausgeschrieben werden ────────────────────────
       *
       * Ein voller Lauf ueber 2997 Fragen kostet 243 Sekunden. Ein Suchlauf
       * ueber dreissig Gewichtungen waere damit zwei Stunden.
       *
       * Die Merkmale haengen aber GAR NICHT von den Gewichten ab — nur ihre
       * Verrechnung tut das. Einmal rechnen, tausendmal bewerten.
       *
       * Wichtig dabei: der Anpasser darf die Punktzahl NICHT selbst
       * nachbauen. Er liest diese Datei und ruft dieselbe `bewerteTopf`, die
       * im Produkt sortiert. Sonst haetten wir wieder zwei Messstaende, die
       * sich langsam auseinanderbewegen — der Fehler vom 20.08.2026.
       */
      merkmalStrom.write(`${JSON.stringify({
        query: q.query,
        art: q.art ?? 'ohne',
        relevant: q.relevant,
        topf: topf.map((t, i) => ({
          t,
          nT: bewertbar[i].naeheText,
          nTh: bewertbar[i].naeheThema,
          nR: bewertbar[i].naeheRueckkopplung,
          sD: bewertbar[i].seltenheitsDeckung,
          // Neu seit dem Naturworkshop 3. Aeltere Merkmalsdateien tragen das
          // Feld nicht — dort liest der Vergleicher 0 fuer alle, und das
          // Merkmal veraendert keine Rangfolge (Topf-Spreizung lauter Gleicher).
          bZ: bewertbar[i].besterZeuge,
          bE: besterEingangVon(t),
        })),
      })}
`);
    }
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

    if (kontobuchPfad && !rrf) {
      // Die richtige Lektion: erste akzeptable — dieselbe Wahl wie
      // bestePlatzierung. Raenge 1-basiert, 0 = im jeweiligen Kanal gar
      // nicht vorhanden (Wort: nicht gefunden; Sinn: ohne Tuervektoren).
      const rel = q.relevant.find((r) => themen.includes(r)) ?? q.relevant[0] ?? '';
      const wortRang = wortVoll.indexOf(rel) + 1;
      const sinnRang = sinnVoll.findIndex((x) => x.t === rel) + 1;
      const relWoerter = textWoerter.get(rel) ?? new Set<string>();
      const gemeinsame = [...fw].map(grobStamm).filter((s) => relWoerter.has(s));
      const seltene = gemeinsame.filter((s) => (dfJeStamm.get(s) ?? 0) <= 2);
      const imTopf = topf.includes(rel);
      // Klasse NUR fuer Decken-Verluste (Vorregistrierung, Grenze 200).
      let klasse = imTopf ? 'im-topf' : 'beide-blind';
      if (!imTopf) {
        const wortKnapp = wortRang > 0 && wortRang <= KLASSENGRENZE;
        const sinnKnapp = sinnRang > 0 && sinnRang <= KLASSENGRENZE;
        if (wortKnapp || sinnKnapp) {
          klasse = wortKnapp && sinnKnapp ? 'knapp-verpasst'
            : wortKnapp ? 'sinn-graben' : 'wortschatz-graben';
        }
      }
      kontobuch.push({
        query: q.query, art, guete: q.guete ?? null, leck: q.leck ?? null,
        form: q.form ?? null, sprache: q.sprache ?? null, tippform: q.tippform ?? null,
        relevant: rel, imTopf, klasse, platz,
        wortRang, sinnRang,
        gemeinsameStaemme: gemeinsame.length, davonDfMax2: seltene.length,
        tuerNaehe: besterEingangVon(rel),
        bestPunkt: (() => { const g = topf.map((t, i) => ({ p: punkte[i] })).sort((a, b) => b.p - a.p)[0]; return g?.p ?? 0; })(),
      });
    }
  }

  if (diagnosePfad && diagnose.length > 0) {
    writeFileSync(resolve(diagnosePfad), diagnose.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
    console.log(`  Diagnose: ${diagnose.length} Zeilen nach ${resolve(diagnosePfad)}`);
  }

  if (kontobuchPfad && kontobuch.length > 0) {
    writeFileSync(resolve(kontobuchPfad), kontobuch.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');
    const verluste = kontobuch.filter((k) => !k.imTopf);
    const jeKlasse = new Map<string, number>();
    for (const k of verluste) jeKlasse.set(String(k.klasse), (jeKlasse.get(String(k.klasse)) ?? 0) + 1);
    console.log(`  Kontobuch: ${kontobuch.length} Zeilen (${verluste.length} Decken-Verluste) nach ${resolve(kontobuchPfad)}`);
    console.log(`  Verlustklassen (Grenze ${KLASSENGRENZE}): ${[...jeKlasse.entries()].map(([k, n]) => `${k}=${n}`).join(' · ')}`);
  }
  if (merkmalStrom) merkmalStrom.end();

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
