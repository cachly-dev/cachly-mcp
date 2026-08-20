/**
 * Der zusammengesetzte Sortierer — und was jeder Bestandteil wirklich beiträgt.
 *
 * ── Der Weg hierher, mit den Sackgassen ─────────────────────────────────────
 *
 * Am 19.08.2026 an 499 echten Lektionen mit 100 Fragen gemessen. Was NICHT
 * funktioniert hat, steht hier, damit es niemand wiederholt:
 *
 *   Symptom-Sicht (what_failed als eigener Vektor)   17 % statt 40 %
 *   Schwerpunkt abziehen                             41 % — im Rauschen
 *   Hauptrichtungen entfernen (1, 3, 6)              37–41 % — im Rauschen
 *   Nabenabzug (CSLS-artig)                          41 % — im Rauschen
 *   Text zerteilen                                   nicht gebaut: das beste
 *     Stück deckt genauso viel ab wie der ganze Text (Verhältnis 1,00) und
 *     liegt bei 86 von 96 Fragen ohnehin am Anfang
 *
 * Was BLEIBT, ist unspektakulär und wirkt:
 *
 *   1. Bedeutungsabgleich über den ganzen Text (Sicht A)
 *   2. Bedeutungsabgleich nur über den Themennamen (Sicht C) — der Name ist
 *      kurz wie eine Frage, der Vergleich also symmetrisch
 *   3. Wortabgleich, klein gewichtet
 *   4. Wortüberlappung mit dem Themennamen
 *   5. Einigkeit: was mehrere Verfahren vorschlagen, stimmt öfter
 *   6. Qualitätsmerkmale der Lektion
 *
 * Alle Punktzahlen werden INNERHALB des Kandidatentopfes auf 0 bis 1 gespreizt.
 * Über den ganzen Bestand liegen die Ähnlichkeiten in einem schmalen Band
 * (0,42 bis 0,61 gemessen); unter fünfzig Kandidaten spreizt die Normierung
 * genau die Unterschiede auf, um die es geht.
 *
 * Eingestellt wird auf der einen Hälfte der Fragen, gemessen auf der anderen.
 *
 * Aufruf:
 *   npx tsx src/bench/alles-zusammen.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { keywordSearch } from '../search.js';
import { mitLektionen } from './mini-redis.js';
import { kosinus, mischeRangfolgen } from '../bedeutung.js';
import { grobStamm as stamm } from '../rangfolge.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;

const lade = (endung: string): Array<number[] | null> => {
  const p = pfad.replace(/\.json$/, endung);
  if (!existsSync(p)) return [];
  const r = JSON.parse(readFileSync(p, 'utf8')) as { alle: Array<number[] | string | null> };
  return r.alle.map((v) => (Array.isArray(v) ? v : null));
};

const aAlle = lade('.einbettungen.json');
if (aAlle.length === 0) { console.error('Einbettungen fehlen'); process.exit(2); }
const sichtA = aAlle.slice(0, korpus.lessons.length);
const fragen = aAlle.slice(korpus.lessons.length);
const sichtC = lade('.sicht-c.json').slice(0, korpus.lessons.length);

const redis = mitLektionen(korpus.lessons);

/**
 * Wie selten ist ein Wort im ganzen Bestand?
 *
 * Trifft eine Frage das Wort "nicht" im Themennamen, sagt das nichts. Trifft
 * sie "fail2ban", ist die Sache praktisch entschieden. Eine ungewichtete
 * Ueberlappung behandelt beide gleich — und genau die bekam beim Einstellen
 * das hoechste Gewicht von allen. Was so viel traegt, verdient es, richtig
 * gerechnet zu werden.
 */
const woerter = (s: string) =>
  new Set(s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 3));

interface Kandidat {
  topic: string;
  naeheA: number; naeheC: number; naeheR: number;
  wortPunkte: number; wortPlatz: number; sinnPlatz: number; themaPlatz: number;
  themaTreffer: number; themaSelten: number; textSelten: number; guete: number; einigkeit: number;
}

function spreize(werte: number[]): number[] {
  const gueltig = werte.filter((x) => Number.isFinite(x) && x > -2);
  if (gueltig.length === 0) return werte.map(() => 0);
  const min = Math.min(...gueltig); const max = Math.max(...gueltig);
  if (max === min) return werte.map(() => 0.5);
  return werte.map((x) => (x > -2 ? (x - min) / (max - min) : 0));
}

const naechste = (f: number[], sicht: Array<number[] | null>, n: number) =>
  sicht.length === 0 ? [] : korpus.lessons
    .map((l, j) => ({ topic: l.topic, s: sicht[j] ? kosinus(f, sicht[j]!) : -2 }))
    .sort((x, y) => y.s - x.s).slice(0, n);

// Seltenheit je Wort, einmal ueber alle Themennamen.
const themaDf = new Map<string, number>();
for (const l of korpus.lessons) {
  for (const w of woerter(l.topic.replace(/[:_-]/g, ' '))) {
    themaDf.set(w, (themaDf.get(w) ?? 0) + 1);
  }
}
const seltenheit = (w: string) =>
  Math.log((korpus.lessons.length + 1) / ((themaDf.get(w) ?? 0) + 1));

// Dasselbe ueber den GANZEN Text jeder Lektion, samt Wortstamm.
//
// Der vorhandene Wortabgleich bekam beim Einstellen das Gewicht NULL — er
// bringt nichts mehr, seit die Bedeutung da ist. Das heisst aber nicht, dass
// Woerter nichts bringen: es heisst, dass BM25 mit seiner Laengennormierung,
// seinen Bigrammen und seinen unscharfen Treffern das Falsche misst.
//
// Was hier steht, ist die einfachste denkbare Form: welcher Anteil der SELTENEN
// Fragewoerter kommt im Text vor. Ohne Laengennormierung, ohne Fuzzy, ohne
// Bigramme.
const volltext = (l: BenchLesson) =>
  [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join(' ');
// Der Stamm kommt aus dem ausgelieferten Modul (Import oben) — keine zweite Fassung.
const textWoerter = korpus.lessons.map((l) => new Set([...woerter(volltext(l))].map(stamm)));
const textDf = new Map<string, number>();
for (const menge of textWoerter) for (const w of menge) textDf.set(w, (textDf.get(w) ?? 0) + 1);
const textSeltenheit = (w: string) =>
  Math.log((korpus.lessons.length + 1) / ((textDf.get(w) ?? 0) + 1));

const POOL = 25;
const kandidatenJeFrage: Kandidat[][] = [];
const ziele: string[] = [];
const nachThema = new Map(korpus.lessons.map((l, j) => [l.topic, j]));

for (const [i, q] of korpus.queries.entries()) {
  const fv = fragen[i];
  const wortListe = (await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, POOL) as Array<{ key: string; score: number }>)
    .map((h) => ({ topic: h.key.replace('cachly:lesson:best:', ''), score: h.score }));
  // ── Rueckkopplung (Rocchio) ─────────────────────────────────────────────
  //
  // Die Frage ist kurz und benutzt Alltagsworte, die Lektionen benutzen
  // Fachworte. Die ersten Treffer sind aber meistens ungefaehr richtig — also
  // wird die Frage mit ihnen angereichert und danach neu gesucht.
  //
  // Kostet nichts: keine neue Einbettung, nur eine Mittelung vorhandener
  // Vektoren. Das Risiko ist bekannt und begrenzt: sind die ersten Treffer
  // falsch, zieht die Anreicherung in die falsche Richtung. Deshalb bleibt die
  // Frage mit dem groesseren Gewicht stehen.
  const angereichert = (() => {
    if (!fv) return null;
    const erste = naechste(fv, sichtA, 3);
    const vs = erste.map((x) => sichtA[nachThema.get(x.topic) ?? -1]).filter(Boolean) as number[][];
    if (vs.length === 0) return null;
    const d = fv.length;
    const m = new Array<number>(d).fill(0);
    for (const v of vs) for (let k = 0; k < d; k++) m[k] += v[k] / vs.length;
    return fv.map((x, k) => 0.75 * x + 0.25 * m[k]);
  })();

  const listeA = fv ? naechste(fv, sichtA, POOL) : [];
  const listeC = fv ? naechste(fv, sichtC, POOL) : [];

  const wortPlatz = new Map(wortListe.map((x, k) => [x.topic, k]));
  const wortPunkte = new Map(wortListe.map((x) => [x.topic, x.score]));
  const platzA = new Map(listeA.map((x, k) => [x.topic, k]));
  const platzC = new Map(listeC.map((x, k) => [x.topic, k]));

  const fw = woerter(q.query);
  const topf = new Set([...wortPlatz.keys(), ...platzA.keys(), ...platzC.keys()]);
  const kand: Kandidat[] = [];
  for (const topic of topf) {
    const j = nachThema.get(topic);
    if (j === undefined) continue;
    const l = korpus.lessons[j] as unknown as Record<string, unknown>;
    const themaW = woerter(topic.replace(/[:_-]/g, ' '));
    const gemeinsam = [...fw].filter((w) => themaW.has(w)).length;
    // Nach Seltenheit gewichtet: ein seltenes gemeinsames Wort wiegt schwer.
    const gewichtetGesamt = [...fw].reduce((s2, w) => s2 + seltenheit(w), 0);
    const gewichtetTreffer = [...fw].filter((w) => themaW.has(w))
      .reduce((s2, w) => s2 + seltenheit(w), 0);
    const dabei = [wortPlatz.has(topic), platzA.has(topic), platzC.has(topic)].filter(Boolean).length;
    kand.push({
      topic,
      naeheA: fv && sichtA[j] ? kosinus(fv, sichtA[j]!) : -2,
      naeheR: angereichert && sichtA[j] ? kosinus(angereichert, sichtA[j]!) : -2,
      naeheC: fv && sichtC[j] ? kosinus(fv, sichtC[j]!) : -2,
      wortPunkte: wortPunkte.get(topic) ?? 0,
      wortPlatz: wortPlatz.get(topic) ?? 999,
      sinnPlatz: platzA.get(topic) ?? 999,
      themaPlatz: platzC.get(topic) ?? 999,
      themaTreffer: fw.size ? gemeinsam / fw.size : 0,
      themaSelten: gewichtetGesamt > 0 ? gewichtetTreffer / gewichtetGesamt : 0,
      textSelten: (() => {
        const tw = textWoerter[j];
        const gestammt = [...fw].map(stamm);
        const gesamt = gestammt.reduce((s2, w) => s2 + textSeltenheit(w), 0);
        if (gesamt <= 0) return 0;
        return gestammt.filter((w) => tw.has(w)).reduce((s2, w) => s2 + textSeltenheit(w), 0) / gesamt;
      })(),
      guete:
        (typeof l.confidence === 'number' ? Math.min(1, l.confidence) : 0.5) * 0.5
        + (l.outcome === 'success' ? 0.3 : 0)
        + (l.severity === 'critical' ? 0.2 : l.severity === 'major' ? 0.1 : 0),
      einigkeit: (dabei - 1) / 2,
    });
  }
  kandidatenJeFrage.push(kand);
  ziele.push(q.relevant[0]);
}

type Teil = 'alle' | 'gerade' | 'ungerade';
function bewerte(punkte: (k: Kandidat[]) => number[], teil: Teil = 'alle') {
  const plaetze: number[] = [];
  kandidatenJeFrage.forEach((kand, i) => {
    if (teil === 'gerade' && i % 2 !== 0) return;
    if (teil === 'ungerade' && i % 2 === 0) return;
    const p = punkte(kand);
    const rang = kand.map((k, j) => ({ t: k.topic, p: p[j] })).sort((x, y) => y.p - x.p);
    plaetze.push(rang.findIndex((r) => r.t === ziele[i]));
  });
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((x) => x >= 0 && x < k).length / n;
  return { n, p1: bis(1), p3: bis(3), p5: bis(5),
    mrr: plaetze.reduce((s, x) => s + (x >= 0 ? 1 / (x + 1) : 0), 0) / n };
}

const zeile = (name: string, e: ReturnType<typeof bewerte>) =>
  `  ${name.padEnd(40)} ${(100 * e.p1).toFixed(0).padStart(4)}% ${(100 * e.p3).toFixed(0).padStart(6)}% `
  + `${(100 * e.p5).toFixed(0).padStart(5)}% ${(100 * e.mrr).toFixed(1).padStart(7)}%`;

interface G { a: number; c: number; w: number; t: number; q: number; e: number; r: number; ts: number; xs: number }
const fn = (g: G) => (kand: Kandidat[]) => {
  const a = spreize(kand.map((k) => k.naeheA));
  const c = spreize(kand.map((k) => k.naeheC));
  const w = spreize(kand.map((k) => k.wortPunkte));
  const r = spreize(kand.map((k) => k.naeheR));
  return kand.map((k, j) => g.a * a[j] + g.c * c[j] + g.w * w[j] + g.r * r[j]
    + g.t * k.themaTreffer + g.ts * k.themaSelten + g.xs * k.textSelten
    + g.q * k.guete + g.e * k.einigkeit);
};

console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${korpus.queries.length} Fragen · Sicht C: ${sichtC.filter(Boolean).length} Vektoren`);
console.log('');
console.log('  Bestandteil einzeln                       P@1    Top3    Top5     MRR');
console.log(zeile('nur Sicht A (heute)', bewerte(fn({ a: 1, c: 0, w: 0, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }))));
console.log(zeile('nur Sicht C (Themenname)', bewerte(fn({ a: 0, c: 1, w: 0, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }))));
console.log(zeile('nur Wortabgleich', bewerte(fn({ a: 0, c: 0, w: 1, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }))));
console.log(zeile('A + C', bewerte(fn({ a: 1, c: 1, w: 0, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }))));
console.log(zeile('heutiges RRF (A + Woerter, 0,1)', bewerte((kand) => {
  const wort = [...kand].sort((x, y) => x.wortPlatz - y.wortPlatz).map((k) => k.topic);
  const sinn = [...kand].sort((x, y) => x.sinnPlatz - y.sinnPlatz).map((k) => k.topic);
  const r = mischeRangfolgen(wort, sinn, 0.1);
  const platz = new Map(r.map((t, i) => [t, i]));
  return kand.map((k) => -(platz.get(k.topic) ?? 999));
})));

// ── Einstellen auf den geraden Fragen ──────────────────────────────────────
/** Sucht die beste Kombination auf einer Haelfte. */
function suche(auf: Teil): G {
  let bester: { g: G; p1: number; mrr: number } | null = null;
  for (const c of [0, 0.3, 0.6])
    for (const r of [0, 0.3, 0.6])
      for (const ts of [0, 0.5, 0.9, 1.4])
        for (const xs of [0, 0.5, 1.0, 1.6])
          for (const e of [0, 0.2, 0.4])
            for (const qg of [0, 0.15]) {
              const g: G = { a: 1, c, w: 0, t: 0, q: qg, e, r, ts, xs };
              const res = bewerte(fn(g), auf);
              if (!bester || res.p1 > bester.p1 || (res.p1 === bester.p1 && res.mrr > bester.mrr)) {
                bester = { g, p1: res.p1, mrr: res.mrr };
              }
            }
  return bester!.g;
}

const nenn = (g: G) => `C${g.c} Rueck${g.r} ThemaSelten${g.ts} TextSelten${g.xs} Guete${g.q} Einig${g.e}`;

// ── Kreuzweise: beide Richtungen, damit keine Haelfte bevorzugt wird ────────
//
// Eine Richtung allein taeuscht, wenn die zwei Haelften unterschiedlich schwer
// sind. Genau das war beim ersten Lauf zu sehen: eingestellt 48 Prozent,
// ungesehen 56 — die ungesehene Haelfte war LEICHTER, nicht das Verfahren
// besser. Erst der Durchschnitt beider Richtungen ist eine Aussage.
const gA = suche('gerade');
const gB = suche('ungerade');
const testA = bewerte(fn(gA), 'ungerade');
const testB = bewerte(fn(gB), 'gerade');
const grundA = bewerte(fn({ a: 1, c: 0, w: 0, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }), 'ungerade');
const grundB = bewerte(fn({ a: 1, c: 0, w: 0, t: 0, q: 0, e: 0, r: 0, ts: 0, xs: 0 }), 'gerade');

console.log('');
console.log('  ── Kreuzweise geprueft (auf der einen Haelfte eingestellt, auf der anderen gemessen) ──');
console.log('');
console.log(`  eingestellt auf gerade:   ${nenn(gA)}`);
console.log(zeile('  -> gemessen auf ungerade', testA));
console.log(`  eingestellt auf ungerade: ${nenn(gB)}`);
console.log(zeile('  -> gemessen auf gerade', testB));
console.log('');
const mit = (100 * (testA.p1 + testB.p1) / 2).toFixed(0);
const ohne = (100 * (grundA.p1 + grundB.p1) / 2).toFixed(0);
const mitM = (100 * (testA.mrr + testB.mrr) / 2).toFixed(1);
const ohneM = (100 * (grundA.mrr + grundB.mrr) / 2).toFixed(1);
console.log(`  DURCHSCHNITT beider Richtungen:`);
console.log(`    zusammengesetzt   P@1 ${mit} %   MRR ${mitM} %`);
console.log(`    nur Sicht A       P@1 ${ohne} %   MRR ${ohneM} %`);
