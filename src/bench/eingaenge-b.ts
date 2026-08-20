/**
 * Variante B: Eingaenge fuer eine Lektion — ganz ohne Sprachmodell.
 *
 * ── Warum es das gibt ────────────────────────────────────────────────────────
 *
 * Eine Frage beschreibt ein SYMPTOM, eine Lektion eine URSACHE. Das ist der
 * gemessene Graben (19.08.2026): 63 % Findequote bei drei Treffern, und keine
 * der zwoelf Sortier-Varianten kam darueber, weil schon die Vorauswahl die
 * richtige Antwort nur in 84 von 100 Faellen enthaelt. Der naechste Punkt kommt
 * nicht aus dem Sortierer, sondern aus mehr TUEREN je Lektion.
 *
 * Der Bauplan sieht zwei Wege zu diesen Tueren:
 *   A: ein Sprachmodell erfindet beim Schreiben Fragen zur Lektion.
 *   B: die Tueren kommen aus dem, was ohnehin dasteht — kein Aufruf, keine
 *      Kosten, keine Abhaengigkeit.
 *
 * Heinrichs Vorgabe am 19.08.: bevorzugt B. Dieses Modul ist B.
 *
 * ── Die vier Tueren von B ───────────────────────────────────────────────────
 *
 *   1. NAME    — der Themenname. Kurz und frageaehnlich; traegt im Verbund mit
 *                Gewicht 0,6, obwohl er allein nur 26 % schafft. Symmetrie
 *                gewinnt: 60 Zeichen gegen 60 Zeichen statt gegen 1376.
 *   2. ERSTSATZ— der erste Satz von what_worked. Die Schreibregel des Hauses
 *                verlangt die entscheidende Tatsache in den ersten 100 Zeichen
 *                ("Briefing zeigt nur 100 Zeichen"). Diese Regel machen wir uns
 *                hier zunutze: der Erstsatz IST die Kurzfassung.
 *   3. FEHLERTEXT — woertliche Meldungen, Codes, GROSSGESCHRIEBENE Kernsaetze.
 *                Nutzer fuegen Fehlermeldungen woertlich ein; das ist der Fall,
 *                den bisher nur der Wortpfad fing. Als eigener Eingang wird er
 *                auch im Bedeutungspfad stark.
 *   4. UEBERSETZUNG — dieselbe Kurzfassung in der anderen Sprache, aus der
 *                vorhandenen Wortpaarliste (DEUTSCHE_FACHWOERTER, seit 13.08.).
 *                Belegt: deutsche Fragen fanden englisches Wissen erst auf
 *                Platz 3-5.
 *
 * ── Was dieses Modul bewusst NICHT tut ──────────────────────────────────────
 *
 * Es erfindet nichts. Jeder Eingang ist ein Ausschnitt oder eine Abbildung des
 * vorhandenen Textes. Steht in einer Lektion kein Fehlertext, bekommt sie
 * keinen — eine leere Tuer ist besser als eine erfundene.
 *
 * Aufruf:
 *   npx tsx src/bench/eingaenge-b.ts --korpus <korpus.json> --out <eingaenge-b.json>
 *   npx tsx src/bench/eingaenge-b.ts --selbstprobe
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEUTSCHE_FACHWOERTER, ohneUmlaute } from '../deutsch.js';
import { fehlertexteAus, ohneMarkierungen } from '../eingaenge.js';
import type { BenchLesson } from './fixtures.js';

// Weiterreichen, damit bestehende Aufrufer und Tests unveraendert bleiben —
// die Fassung selbst steht seit dem 20.08.2026 im Produktionsmodul.
export { ohneMarkierungen };
export const fehlertexte = fehlertexteAus;

export type Eingangsart = 'name' | 'volltext' | 'erstsatz' | 'fehlertext' | 'uebersetzung';
export interface Eingang { art: Eingangsart; text: string }

/** Der Themenname als lesbarer Satz: Trennzeichen raus, Woerter rein. */
export function nameAlsSatz(topic: string): string {
  return topic.replace(/[:_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Der erste Satz von what_worked.
 *
 * Nicht einfach `split('.')`: Abkuerzungen, Versionsnummern, Datumsangaben
 * (19.08.2026) und Adressen (10.8.0.7) enthalten Punkte. Deshalb endet ein Satz
 * hier nur an einem Punkt, dem ein Leerzeichen und ein Grossbuchstabe folgen —
 * oder an einem Zeilenumbruch.
 */
export function ersterSatz(text: string, hoechstens = 300): string {
  const t = ohneMarkierungen(text);
  if (!t) return '';
  const zeile = t.split(/\n/)[0];
  const treffer = /[.!?](\s+[A-ZÄÖÜ(])/.exec(zeile);
  let satz = treffer ? zeile.slice(0, treffer.index + 1) : zeile;
  // Ein sehr kurzer erster Satz ("BEHOBEN.") sagt nichts — dann den zweiten dazu.
  // Gemessen wird in WOERTERN, nicht in Zeichen: "GEMESSEN 19.08.2026 an 499
  // Lektionen." ist 37 Zeichen lang und trotzdem ein vollstaendiger Satz.
  if (satz.split(/\s+/).filter(Boolean).length < 4 && zeile.length > satz.length) {
    const rest = zeile.slice(satz.length);
    const zweiter = /[.!?](\s+[A-ZÄÖÜ(])/.exec(rest);
    satz += zweiter ? rest.slice(0, zweiter.index + 1) : rest;
  }
  return satz.trim().slice(0, hoechstens);
}

/**
 * Die Wortpaarliste als Nachschlagewerk in BEIDE Richtungen.
 *
 * Die Liste ist deutsch->englisch gepflegt. Fuer die Uebersetzung braucht es
 * auch englisch->deutsch, und die entsteht hier durch Umdrehen — KEINE zweite
 * Liste, die gepflegt werden muesste (die Fehlerklasse "zweite Wahrheit").
 */
const HINRICHTUNG = new Map<string, string>();
const RUECKRICHTUNG = new Map<string, string>();
for (const [de, ens] of DEUTSCHE_FACHWOERTER) {
  const d = ohneUmlaute(de);
  const e = ens[0];
  if (!e) continue;
  if (e !== d && !HINRICHTUNG.has(d)) HINRICHTUNG.set(d, e);
  if (!RUECKRICHTUNG.has(e) && e !== d) RUECKRICHTUNG.set(e, d);
}

/**
 * Bildet den Text in die jeweils andere Sprache ab, Wort fuer Wort.
 *
 * Das ist keine Uebersetzung im sprachlichen Sinn und soll auch keine sein. Es
 * geht nur darum, dass eine englische Frage an deutschem Wissen andockt und
 * umgekehrt — dafuer reichen die Fachwoerter, denn die tragen die Bedeutung.
 *
 * Zurueck kommt null, wenn weniger als zwei Woerter getroffen wurden: ein Text
 * mit einer einzigen Ersetzung ist keine zweite Tuer, sondern Rauschen.
 */
export function uebersetzung(text: string, mindestens = 2): string | null {
  let getroffen = 0;
  const aus = text.split(/(\s+)/).map((stueck) => {
    if (/^\s+$/.test(stueck) || !stueck) return stueck;
    const roh = stueck.toLowerCase().replace(/[^a-zäöüß0-9-]/g, '');
    if (roh.length < 4) return stueck;
    const schluessel = ohneUmlaute(roh);
    const ziel = HINRICHTUNG.get(schluessel) ?? RUECKRICHTUNG.get(schluessel);
    if (!ziel) return stueck;
    getroffen++;
    return stueck.replace(new RegExp(roh, 'i'), ziel);
  }).join('');
  return getroffen >= mindestens ? aus.trim() : null;
}

/** Alle Eingaenge einer Lektion, Variante B. */
export function eingaengeFuer(l: BenchLesson): Eingang[] {
  const wf = (l as { what_failed?: string }).what_failed ?? '';
  const voll = `${l.what_worked ?? ''}\n${wf}`;
  const name = nameAlsSatz(l.topic);
  const satz = ersterSatz(l.what_worked ?? '');

  const aus: Eingang[] = [
    { art: 'name', text: name },
    { art: 'volltext', text: ohneMarkierungen(voll).slice(0, 2000) },
  ];
  if (satz) aus.push({ art: 'erstsatz', text: satz });
  for (const f of fehlertexte(voll)) aus.push({ art: 'fehlertext', text: f });

  // Uebersetzt wird die Kurzfassung (Name + Erstsatz), nicht der ganze Text:
  // eine Wort-fuer-Wort-Abbildung von 1400 Zeichen ist kein Satz mehr.
  const u = uebersetzung(`${name}. ${satz}`.slice(0, 400));
  if (u) aus.push({ art: 'uebersetzung', text: u });

  return aus;
}

// ── Selbstprobe ─────────────────────────────────────────────────────────────

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('Markierungen fliegen raus',
    ohneMarkierungen('a </what_worked>\n<what_failed> b') === 'a b');

  p('Erstsatz endet nicht am Datum',
    ersterSatz('GEMESSEN 19.08.2026 an 499 Lektionen. Der Rest ist egal.')
      === 'GEMESSEN 19.08.2026 an 499 Lektionen.');

  p('Erstsatz endet nicht an einer Adresse',
    ersterSatz('WHISPER LAEUFT AUF 10.8.0.7:3095 mit large-v3. Zweiter Satz.')
      === 'WHISPER LAEUFT AUF 10.8.0.7:3095 mit large-v3.');

  p('sehr kurzer Erstsatz wird ergaenzt',
    ersterSatz('BEHOBEN. Der Port stand doppelt und die zweite App gewann.').length > 20);

  const f1 = fehlertexte('Der Deploy brach ab mit "No space left on device" und der Runner stand.');
  p('Fehlertext in Anfuehrungszeichen gefunden', f1.includes('No space left on device'));

  const f2 = fehlertexte('Es kam ein UnknownHostException: postgres und jeder Login war tot.');
  p('Fehlerklasse gefunden', f2.some((x) => x.startsWith('UnknownHostException')));

  const f3 = fehlertexte('Der Runner starb mit EACCES beim Schreiben.');
  p('Systemkuerzel mit Umfeld gefunden', f3.some((x) => x.startsWith('EACCES ')));

  const f4 = fehlertexte('DIE PLATTE WAR VOLL UND DER DEPLOY HING. Danach lief alles wieder.');
  p('Grossgeschriebener Kernsatz gefunden',
    f4.some((x) => x.includes('DIE PLATTE WAR VOLL')));

  p('harmloser Text liefert keinen Fehlertext',
    fehlertexte('Wir haben die Reihenfolge der Schritte getauscht und es lief.').length === 0);

  const u = uebersetzung('platte voll beim ausrollen, tests haengen');
  p('Uebersetzung greift bei mehreren Fachwoertern',
    u !== null && /disk/.test(u) && /deploy/.test(u));

  p('Uebersetzung schweigt bei einem einzigen Treffer',
    uebersetzung('gestern abend war alles gut, nur die platte') === null);

  const l = {
    topic: 'ci:node3-disk-full-zombie-deploy',
    outcome: 'success',
    what_worked: 'DIE PLATTE WAR VOLL. Der Worker meldete "No space left on device", '
      + 'gh run cancel reichte nicht, der Runner-Dienst musste neu starten.',
    what_failed: 'docker system prune ohne --all nahm nur die anonymen Volumes.',
  } as BenchLesson;
  const e = eingaengeFuer(l);
  const arten = new Set(e.map((x) => x.art));
  p('Lektion bekommt Name, Volltext, Erstsatz, Fehlertext',
    arten.has('name') && arten.has('volltext') && arten.has('erstsatz') && arten.has('fehlertext'));
  p('Name ist lesbar', e[0].text === 'ci node3 disk full zombie deploy');
  p('kein leerer Eingang', e.every((x) => x.text.trim().length > 0));

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

// ── Einstieg ────────────────────────────────────────────────────────────────

// Nur ausfuehren, wenn DIESE Datei gestartet wurde. Sonst kann kein anderes
// Werkzeug `eingaengeFuer` importieren, ohne den Hauptteil auszuloesen.
const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('/eingaenge-b.ts');

if (direktGestartet && process.argv.includes('--selbstprobe')) selbstprobe();
else if (direktGestartet) {
  const argv = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const korpusPfad = resolve(flag('korpus') ?? '');
  const ziel = resolve(flag('out') ?? './eingaenge-b.json');
  if (!existsSync(korpusPfad)) {
    console.error(`NICHT GEMESSEN: Korpus fehlt (${korpusPfad}).`);
    process.exit(2);
  }
  const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as { lessons: BenchLesson[] };
  const lektionen = korpus.lessons.map((l) => ({ topic: l.topic, eingaenge: eingaengeFuer(l) }));

  const zaehl = new Map<string, number>();
  for (const l of lektionen) for (const e of l.eingaenge) zaehl.set(e.art, (zaehl.get(e.art) ?? 0) + 1);
  const gesamt = [...zaehl.values()].reduce((a, b) => a + b, 0);
  const neu = gesamt - (zaehl.get('name') ?? 0) - (zaehl.get('volltext') ?? 0);

  writeFileSync(ziel, JSON.stringify({ lektionen }, null, 1), 'utf8');
  console.log(`${lektionen.length} Lektionen, ${gesamt} Eingaenge (${(gesamt / lektionen.length).toFixed(1)} je Lektion).`);
  console.log('Nach Art:', [...zaehl.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}=${n}`).join(' '));
  console.log(`Neu einzubetten: ${neu} (Name und Volltext liegen als Sicht C bzw. Sicht A schon vor).`);
  console.log(`Geschrieben nach ${ziel}`);
}
