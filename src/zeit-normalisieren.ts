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

/** Ein Monat als Ganzes: "2026-07". */
function alsIsoMonat(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/*
 * ── Spannen bekommen eine Spanne, keinen Tag (29.10.2026) ───────────────────
 *
 * Bis heute wurde "last week" zu "last week (2026-08-20)": genau sieben Tage
 * zurueck. Eine Woche ist aber kein Tag. Wer das Datum liest, haelt es fuer den
 * Tag des Ereignisses — und rechnet falsch weiter.
 *
 * Gemessen auf LoCoMo (OmniMemEval, Laeufe aml05 und aml05c): Die Antwort
 * nannte "28 January 2023", die Frage fragte nach dem Ereignis "on 4 February
 * 2023", der Richter wertete falsch. In den LoCoMo-Musterantworten lauten 28
 * von 30 "last week"-Faellen "The week before 9 June 2023", nur 2 nennen einen
 * Tag; "last month" wird als Monat beantwortet.
 *
 * Darum: Tage und Wochentage behalten ihr Tagesdatum. Wochen und Wochenenden
 * nennen den Bezugstag ("the week before 2026-08-27"), Monate den Monat
 * ("2026-07").
 */
const tag = (d: Date): string => alsIsoTag(d);
const wochenVorEn = (j: Date, n: number): string => `${n} week${n === 1 ? '' : 's'} before ${alsIsoTag(j)}`;
const wochenVorDe = (j: Date, n: number): string => `${n} Wochen vor dem ${alsIsoTag(j)}`;

/** Der letzte Wochentag `wd` (0 = Sonntag) VOR `jetzt`: 1 bis 7 Tage zurueck. */
function letzterWochentag(jetzt: Date, wd: number): Date {
  return tageVor(jetzt, (jetzt.getDay() - wd + 7) % 7 || 7);
}

const WOCHENTAG: Record<string, number> = {
  sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const wochentagVor = (j: Date, m: RegExpMatchArray): string | null => {
  const wd = WOCHENTAG[m[2].toLowerCase()];
  return wd === undefined ? null : tag(letzterWochentag(j, wd));
};
/** "letzten Freitag im Monat" / "last Friday of the month" wiederholt sich — kein Datum. */
const NICHT_WIEDERKEHREND = String.raw`(?!\s+(?:im|des|eines|jedes|of|in)\b)`;

/**
 * Die Muster. Reihenfolge zaehlt: laengere Ausdruecke zuerst, sonst frisst
 * "Woche" das "letzte Woche" auf.
 *
 * `angabe` liefert den Klammerinhalt aus dem Schreibzeitpunkt und den
 * gefangenen Gruppen. Gibt es keine sinnvolle Angabe, liefert es null und der
 * Treffer bleibt unangetastet.
 */
const MUSTER: { re: RegExp; angabe: (jetzt: Date, m: RegExpMatchArray) => string | null }[] = [
  // Deutsch — Tage
  { re: /\bvorgestern\b/gi, angabe: (j) => tag(tageVor(j, 2)) },
  { re: /\buebermorgen\b|\bübermorgen\b/gi, angabe: (j) => tag(tageVor(j, -2)) },
  { re: /\bgestern\b/gi, angabe: (j) => tag(tageVor(j, 1)) },
  { re: /\bmorgen\b/gi, angabe: (j) => tag(tageVor(j, -1)) },
  { re: /\bheute\b/gi, angabe: (j) => tag(j) },
  // Deutsch — Spannen
  { re: /\bvor\s+(\d{1,3})\s+Tagen\b/gi, angabe: (j, m) => tag(tageVor(j, Number(m[1]))) },
  { re: /\bvor\s+(\d{1,3})\s+Wochen\b/gi, angabe: (j, m) => wochenVorDe(j, Number(m[1])) },
  { re: /\bvor\s+(\d{1,3})\s+Monaten\b/gi, angabe: (j, m) => alsIsoMonat(monateVor(j, Number(m[1]))) },
  { re: /\bvor\s+einer\s+Woche\b/gi, angabe: (j) => `eine Woche vor dem ${alsIsoTag(j)}` },
  { re: /\bvor\s+einem\s+Monat\b/gi, angabe: (j) => alsIsoMonat(monateVor(j, 1)) },
  {
    re: /\b(letztes|vergangenes|voriges|letzten|vergangenen|vorigen)\s+Wochenende\b/gi,
    angabe: (j) => `das Wochenende vor dem ${alsIsoTag(j)}`,
  },
  { re: /\b(letzte|letzten|letzter|vorige|vorigen)\s+Woche\b/gi, angabe: (j) => `die Woche vor dem ${alsIsoTag(j)}` },
  { re: /\b(letzten|letzter|vorigen)\s+Monat\b/gi, angabe: (j) => alsIsoMonat(monateVor(j, 1)) },
  {
    re: new RegExp(String.raw`\b(letzten|vergangenen|vorigen)\s+(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)\b${NICHT_WIEDERKEHREND}`, 'gi'),
    angabe: wochentagVor,
  },
  // Englisch
  { re: /\bthe\s+day\s+before\s+yesterday\b/gi, angabe: (j) => tag(tageVor(j, 2)) },
  { re: /\byesterday\b/gi, angabe: (j) => tag(tageVor(j, 1)) },
  { re: /\btomorrow\b/gi, angabe: (j) => tag(tageVor(j, -1)) },
  { re: /\btoday\b/gi, angabe: (j) => tag(j) },
  { re: /\b(\d{1,3})\s+days?\s+ago\b/gi, angabe: (j, m) => tag(tageVor(j, Number(m[1]))) },
  { re: /\b(\d{1,3})\s+weeks?\s+ago\b/gi, angabe: (j, m) => wochenVorEn(j, Number(m[1])) },
  { re: /\b(\d{1,3})\s+months?\s+ago\b/gi, angabe: (j, m) => alsIsoMonat(monateVor(j, Number(m[1]))) },
  { re: /\blast\s+weekend\b/gi, angabe: (j) => `the weekend before ${alsIsoTag(j)}` },
  { re: /\blast\s+week\b/gi, angabe: (j) => `the week before ${alsIsoTag(j)}` },
  { re: /\blast\s+month\b/gi, angabe: (j) => alsIsoMonat(monateVor(j, 1)) },
  {
    re: new RegExp(String.raw`\b(last)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b${NICHT_WIEDERKEHREND}`, 'gi'),
    angabe: wochentagVor,
  },
  // Kurzformen nur grossgeschrieben ("last Tues", "last Fri"): klein waeren
  // "I last sat down" oder "the last sun" Treffer.
  {
    re: new RegExp(String.raw`\b([Ll]ast)\s+(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b${NICHT_WIEDERKEHREND}`, 'g'),
    angabe: wochentagVor,
  },
];

/**
 * Was diese Datei in eine Klammer schreibt: ein Tag, ein Monat oder eine
 * Spanne mit Bezugstag. Dient der Idempotenz und dem Zaehlen. Alte Lektionen
 * tragen noch "(2026-08-20)" hinter "last week" — das gilt als aufgeloest und
 * wird nicht ein zweites Mal ergaenzt.
 */
const ANGABE = String.raw`\((?:\d{4}-\d{2}(?:-\d{2})?|(?:the week(?:end)? before|\d{1,3} weeks? before|die Woche vor dem|das Wochenende vor dem|eine Woche vor dem|\d{1,3} Wochen vor dem) \d{4}-\d{2}-\d{2})\)`;
const SCHON_AUFGELOEST = new RegExp(String.raw`^\s*${ANGABE}`);
const ANGABEN = new RegExp(ANGABE, 'g');

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
  const funde: { ende: number; angabe: string }[] = [];
  const belegt: [number, number][] = [];
  for (const { re, angabe } of MUSTER) {
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
      if (SCHON_AUFGELOEST.test(text.slice(bis))) continue;
      if (Number.isNaN(jetzt.getTime())) continue;
      const a = angabe(jetzt, m);
      if (!a || a.includes('NaN')) continue;
      belegt.push([von, bis]);
      funde.push({ ende: bis, angabe: a });
    }
  }
  if (funde.length === 0) return text;
  funde.sort((a, b) => b.ende - a.ende);
  let out = text;
  for (const f of funde) out = `${out.slice(0, f.ende)} (${f.angabe})${out.slice(f.ende)}`;
  return out;
}

/** Wie viele Angaben wuerde `normalisiereZeit` anfassen? Fuer Rueckmeldungen. */
export function zaehleZeitangaben(text: string, jetzt: Date): number {
  if (!text) return 0;
  const vorher = (text.match(ANGABEN) ?? []).length;
  const nachher = (normalisiereZeit(text, jetzt).match(ANGABEN) ?? []).length;
  return nachher - vorher;
}
