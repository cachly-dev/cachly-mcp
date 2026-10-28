/**
 * Relative Zeitangaben beim SCHREIBEN aufloesen (Karte 2bfm7dyvjmeh).
 *
 * ── Warum das der staerkste gemessene Hebel ist ─────────────────────────────
 *
 * LoCoMo-Lauf 2 (26.08.2026, BEFUND-lauf-2.md): die Kategorie "Temporal"
 * sprang im Holdout von 23,1 auf 57,7 Prozent — +34,6 Punkte, der groesste
 * Einzeleffekt des ganzen Laufs. Der Grund ist unspektakulaer: dort wurde
 * "yesterday" beim SCHREIBEN zu "7 May 2023" und musste beim Lesen nie mehr
 * geraten werden.
 *
 * Eine Lektion mit "gestern" darin ist am Tag des Schreibens klar und drei
 * Wochen spaeter wertlos. Der Text bleibt gleich, sein Bezugspunkt verschwindet.
 *
 * ── Drei Regeln, die diese Datei klein halten ───────────────────────────────
 *
 * 1. ERGAENZEN, NIE ERSETZEN. Aus "gestern" wird "gestern (2026-08-26)".
 *    Der Originaltext bleibt unangetastet — wer ihn spaeter liest, sieht
 *    beides. Ein Ersetzen waere eine stille Aenderung fremder Worte.
 * 2. NUR EINDEUTIGES. "am Montag" kann vergangen oder kuenftig sein und
 *    wird NICHT angefasst. Lieber eine Angabe unaufgeloest lassen als eine
 *    falsch aufloesen — eine falsche Zahl ist schlimmer als keine.
 *    "letzten Freitag" / "last Friday" IST eindeutig: der letzte Freitag VOR
 *    dem Bezugstag, 1 bis 7 Tage zurueck (so rechnen auch die LoCoMo-Loesungen:
 *    "The Friday before 22 October 2023"). Bis 28.10.2026 blieb er offen; das
 *    Antwortmodell rechnete dann oft eine Woche zu frueh, und die Zeitfragen
 *    im neutralen OmniMemEval-Aufbau lagen bei 75,1 %, mit Datum bei 81,9 %.
 *    Wiederkehrendes ("letzten Freitag im Monat", "last Friday of the month")
 *    bleibt stehen.
 * 3. NUR ZEIT. Die v2-Lehre aus demselben Lauf: ein Faktentyp je Iteration.
 *    v2 bestellte zusaetzlich implizite Zustaende und Gespraechsmomente und
 *    FIEL von 45,2 auf 39,5 Prozent — mehr Buendel konkurrieren um denselben
 *    Topf. Diese Datei fasst deshalb ausschliesslich Datumsangaben an.
 *
 * Rein und ohne Seiteneffekte: `jetzt` kommt als Argument herein, damit der
 * Test nicht von der Uhr abhaengt.
 */

/** ISO-Datum ohne Zeitzone-Ueberraschungen: der Tag, wie er lokal gilt. */
function alsIsoTag(d: Date): string {
  const jahr = d.getFullYear();
  const monat = String(d.getMonth() + 1).padStart(2, '0');
  const tag = String(d.getDate()).padStart(2, '0');
  return `${jahr}-${monat}-${tag}`;
}

function tageVor(jetzt: Date, n: number): Date {
  const d = new Date(jetzt.getTime());
  d.setDate(d.getDate() - n);
  return d;
}

function monateVor(jetzt: Date, n: number): Date {
  const d = new Date(jetzt.getTime());
  d.setMonth(d.getMonth() - n);
  return d;
}

/** Der letzte Wochentag `wd` (0 = Sonntag) VOR `jetzt`: 1 bis 7 Tage zurueck. */
function letzterWochentag(jetzt: Date, wd: number): Date {
  return tageVor(jetzt, (jetzt.getDay() - wd + 7) % 7 || 7);
}

const WOCHENTAG: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const wochentagVor = (j: Date, m: RegExpMatchArray): Date | null => {
  const wd = WOCHENTAG[m[2].toLowerCase()];
  return wd === undefined ? null : letzterWochentag(j, wd);
};
/** "letzten Freitag im Monat" / "last Friday of the month" wiederholt sich — kein Datum. */
const NICHT_WIEDERKEHREND = String.raw`(?!\s+(?:im|des|eines|jedes|of|in)\b)`;

/**
 * Die Muster. Reihenfolge zaehlt: laengere Ausdruecke zuerst, sonst frisst
 * "Woche" das "letzte Woche" auf.
 *
 * `versatz` liefert das gemeinte Datum aus dem Schreibzeitpunkt und den
 * gefangenen Gruppen. Gibt es keine sinnvolle Zahl, liefert es null und der
 * Treffer bleibt unangetastet.
 */
const MUSTER: { re: RegExp; versatz: (jetzt: Date, m: RegExpMatchArray) => Date | null }[] = [
  // Deutsch — Tage
  { re: /\bvorgestern\b/gi, versatz: (j) => tageVor(j, 2) },
  { re: /\buebermorgen\b|\bübermorgen\b/gi, versatz: (j) => tageVor(j, -2) },
  { re: /\bgestern\b/gi, versatz: (j) => tageVor(j, 1) },
  { re: /\bmorgen\b/gi, versatz: (j) => tageVor(j, -1) },
  { re: /\bheute\b/gi, versatz: (j) => j },
  // Deutsch — Spannen
  { re: /\bvor\s+(\d{1,3})\s+Tagen\b/gi, versatz: (j, m) => tageVor(j, Number(m[1])) },
  { re: /\bvor\s+(\d{1,3})\s+Wochen\b/gi, versatz: (j, m) => tageVor(j, 7 * Number(m[1])) },
  { re: /\bvor\s+(\d{1,3})\s+Monaten\b/gi, versatz: (j, m) => monateVor(j, Number(m[1])) },
  { re: /\bvor\s+einer\s+Woche\b/gi, versatz: (j) => tageVor(j, 7) },
  { re: /\bvor\s+einem\s+Monat\b/gi, versatz: (j) => monateVor(j, 1) },
  { re: /\b(letzte|letzten|letzter|vorige|vorigen)\s+Woche\b/gi, versatz: (j) => tageVor(j, 7) },
  { re: /\b(letzten|letzter|vorigen)\s+Monat\b/gi, versatz: (j) => monateVor(j, 1) },
  {
    re: new RegExp(String.raw`\b(letzten|vergangenen|vorigen)\s+(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b${NICHT_WIEDERKEHREND}`, 'gi'),
    versatz: wochentagVor,
  },
  // Englisch
  { re: /\bthe\s+day\s+before\s+yesterday\b/gi, versatz: (j) => tageVor(j, 2) },
  { re: /\byesterday\b/gi, versatz: (j) => tageVor(j, 1) },
  { re: /\btomorrow\b/gi, versatz: (j) => tageVor(j, -1) },
  { re: /\btoday\b/gi, versatz: (j) => j },
  { re: /\b(\d{1,3})\s+days?\s+ago\b/gi, versatz: (j, m) => tageVor(j, Number(m[1])) },
  { re: /\b(\d{1,3})\s+weeks?\s+ago\b/gi, versatz: (j, m) => tageVor(j, 7 * Number(m[1])) },
  { re: /\b(\d{1,3})\s+months?\s+ago\b/gi, versatz: (j, m) => monateVor(j, Number(m[1])) },
  { re: /\blast\s+week\b/gi, versatz: (j) => tageVor(j, 7) },
  { re: /\blast\s+month\b/gi, versatz: (j) => monateVor(j, 1) },
  {
    re: new RegExp(String.raw`\b(last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b${NICHT_WIEDERKEHREND}`, 'gi'),
    versatz: wochentagVor,
  },
  // Kurzformen nur grossgeschrieben ("last Tues", "last Fri"): klein waeren
  // "I last sat down" oder "the last sun" Treffer.
  {
    re: new RegExp(String.raw`\b([Ll]ast)\s+(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b${NICHT_WIEDERKEHREND}`, 'g'),
    versatz: wochentagVor,
  },
];

/**
 * Bereiche, die unangetastet bleiben: Code UND wörtliche Zitate.
 *
 * ── Warum Zitate dazugehören (28.08.2026) ─────────────────────────────────
 *
 * Die Karte 2bfm7dyvjmeh liess die Frage ausdrücklich offen: bleibt
 * „gestern" in einem wörtlichen Zitat unangetastet? Bis heute nicht — Code
 * war geschützt, Zitate nicht.
 *
 * Sie fällt so aus: ZITAT SCHLÄGT AUFLÖSUNG. Steht „gestern" zwischen
 * Anführungszeichen, ist es FREMDER Text. Wer dort etwas einfügt, fälscht
 * ein Zitat — und der Leser kann danach nicht mehr unterscheiden, was
 * zitiert war und was wir ergänzt haben.
 *
 * Das ist dieselbe Regel wie „ergänzen, nie ersetzen", eine Ebene tiefer:
 * fremde Worte bleiben fremde Worte.
 */
function tabuBereiche(text: string): [number, number][] {
  const bereiche: [number, number][] = [];
  for (const re of [
    /```[\s\S]*?```/g,        // Code-Block
    /`[^`\n]*`/g,             // Code im Fliesstext
    /"[^"\n]*"/g,             // gerade Anführungszeichen
    /„[^“\n]*“/g,             // deutsche: unten, oben
    /«[^»\n]*»/g,             // Guillemets
  ]) {
    for (const m of text.matchAll(re)) {
      if (m.index !== undefined) bereiche.push([m.index, m.index + m[0].length]);
    }
  }
  return bereiche;
}

const istImTabu = (bereiche: [number, number][], von: number, bis: number): boolean =>
  bereiche.some(([a, b]) => von < b && bis > a);

/**
 * Haengt hinter jede eindeutige relative Zeitangabe das gemeinte Datum in
 * Klammern. Der Originaltext bleibt Wort fuer Wort erhalten.
 *
 * Zweimal angewendet aendert sich nichts mehr (idempotent): steht hinter
 * einem Treffer bereits ein Datum in Klammern, wird er uebersprungen. Das
 * ist wichtig, weil Lektionen nachbearbeitet und neu gespeichert werden.
 */
export function normalisiereZeit(text: string, jetzt: Date): string {
  if (!text) return text;
  const tabu = tabuBereiche(text);
  // Alle Treffer sammeln, dann VON HINTEN einsetzen — sonst verschieben die
  // ersten Einfuegungen die Fundstellen aller spaeteren.
  const funde: { ende: number; datum: string }[] = [];
  const belegt: [number, number][] = [];
  for (const { re, versatz } of MUSTER) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const von = m.index;
      if (von === undefined) continue;
      const bis = von + m[0].length;
      if (istImTabu(tabu, von, bis)) continue;
      // Ein laengeres Muster hat diese Stelle schon: "letzte Woche" gewinnt
      // gegen ein spaeteres, kuerzeres Muster an derselben Stelle.
      if (istImTabu(belegt, von, bis)) continue;
      // Schon aufgeloest? Dann nichts tun (Idempotenz).
      if (/^\s*\(\d{4}-\d{2}-\d{2}\)/.test(text.slice(bis))) continue;
      const d = versatz(jetzt, m);
      if (!d || Number.isNaN(d.getTime())) continue;
      belegt.push([von, bis]);
      funde.push({ ende: bis, datum: alsIsoTag(d) });
    }
  }
  if (funde.length === 0) return text;
  funde.sort((a, b) => b.ende - a.ende);
  let out = text;
  for (const f of funde) out = `${out.slice(0, f.ende)} (${f.datum})${out.slice(f.ende)}`;
  return out;
}

/** Wie viele Angaben wuerde `normalisiereZeit` anfassen? Fuer Rueckmeldungen. */
export function zaehleZeitangaben(text: string, jetzt: Date): number {
  if (!text) return 0;
  const vorher = (text.match(/\(\d{4}-\d{2}-\d{2}\)/g) ?? []).length;
  const nachher = (normalisiereZeit(text, jetzt).match(/\(\d{4}-\d{2}-\d{2}\)/g) ?? []).length;
  return nachher - vorher;
}
