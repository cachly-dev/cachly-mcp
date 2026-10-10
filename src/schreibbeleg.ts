/**
 * Schreibbeleg — wer "gespeichert" sagt, muss gespeichert haben.
 *
 * ── Warum es diese Datei gibt (07.10.2026) ──────────────────────────────────
 *
 * `learn_from_attempts` antwortete mit einem Satz ("Lesson stored"), den ein
 * Modell auch frei erfinden kann. Ob ein Agent wirklich ins Brain geschrieben
 * oder es nur behauptet hat, liess sich bisher nur von Hand nachpruefen — und
 * niemand tut das. Stille wird als gruen gebucht.
 *
 * Zwei Teile:
 *
 *   1. `belegFuer` — jede Speicherung bekommt einen kurzen Beleg (8 Hexzeichen
 *      aus Thema, Zeit und Inhalt). Er steht in der Werkzeugantwort und bei
 *      der Lektion. Ein Beleg, den kein Werkzeug ausgegeben hat, ist erfunden.
 *   2. `pruefeZug` — der Stop-Hook liest das Gespraechsprotokoll des letzten
 *      Zugs. Behauptet die Antwort eine Speicherung, ohne dass ein
 *      Schreibwerkzeug erfolgreich lief, oder nennt sie einen Beleg, den kein
 *      Werkzeug ausgegeben hat, schickt der Hook das Modell einmal zurueck.
 *
 * Was das NICHT leistet: es prueft nicht, ob der gespeicherte Inhalt stimmt.
 * Und es erkennt nur Behauptungen in den ueblichen Worten (deutsch/englisch);
 * wer es umschreibt, kommt durch. Der Zweck ist, das versehentliche und das
 * bequeme Vortaeuschen zu fangen — die haeufigen Faelle.
 */

import { createHash } from 'node:crypto';

/** Werkzeuge, die ins Brain schreiben. MCP-Namen kommen mit Praefix (`mcp__cachly__…`). */
const SCHREIBWERKZEUG = /(?:^|__)(learn_from_attempts|remember_context|session_end|session_handoff|team_learn|global_learn|auto_learn_session)$/;

/** Antworten, die trotz "kein Fehler" nichts geschrieben haben. */
const ABGEWIESEN = /^\s*(✋|⛔|Error\b|Fehler\b|Update abgewiesen|Rejected)/i;

const BELEG_MUSTER = /\bBeleg:\s*`?([0-9a-f]{8})`?/gi;

// "Lektion … gespeichert", "saved to the brain", "ins Brain geschrieben" …
const BEHAUPTUNG = [
  /\b(lektion(en)?|lesson|brain|gedaechtnis|gedächtnis|memory|cachly)\b[^.\n]{0,80}\b(gespeichert|abgelegt|eingetragen|festgehalten|hinterlegt|geschrieben|stored|saved|recorded|persisted)\b/i,
  /\b(gespeichert|abgelegt|eingetragen|festgehalten|hinterlegt|geschrieben|stored|saved|recorded|persisted|learned)\b[^.\n]{0,40}\b(im|ins|in the|to the|to|into)\s+(brain|gedaechtnis|gedächtnis|memory)\b/i,
  // "steht als kritische Lektion im Brain", "as a new lesson" — gefunden am eigenen Protokoll
  // — aber nicht der Vergleich "anders formuliert als die Lektion".
  /\b(als|as an?)\s+(?!(?:die|der|das|den|dem|the)\b)(?:[\wäöüß-]+\s+){0,2}(lektion|lesson)\b/i,
];

/** Kurzer, nachpruefbarer Beleg einer Speicherung. */
export function belegFuer(topic: string, zeit: string, inhalt: string): string {
  return createHash('sha256').update(`${topic}\n${zeit}\n${inhalt}`).digest('hex').slice(0, 8);
}

// Fragen und Angebote sind keine Behauptung: "Soll ich das als Lektion speichern?"
const ANGEBOT = /\?\s*$|\b(soll ich|kann ich|darf ich|moechtest|möchtest|willst|wenn du|falls du|shall i|should i|would you|want me to|if you)\b/i;

/*
 * Rede UEBER die KI ist keine Meldung der KI (Fehlalarm vom 08.10.2026).
 *
 * Die Antwort beschrieb diese Funktion: "cachly ertappt die KI, wenn sie
 * behauptet, etwas gespeichert zu haben". Das Wort "cachly" und "gespeichert"
 * standen im selben Satz, also schlug die Pruefung an — obwohl nichts gemeldet
 * wurde. Eng gefasst: der Satz muss die KI in dritter Person nennen UND einen
 * Nebensatz-Anker haben (wenn/ob/falls/dass/behauptet, if/whether/claims).
 * "Ich habe das im Brain gespeichert" hat keines von beiden und schlaegt weiter an.
 */
const KI_DRITTE_PERSON = '(?:die ki|das modell|der agent|der assistent|the (?:ai|model|agent|assistant)|claude)';
const NEBENSATZ_ANKER = '(?:wenn|ob|falls|dass|behauptet|if|whether|claims?|says?)';
const REDE_UEBER_KI = new RegExp(
  `\\b${KI_DRITTE_PERSON}\\b[^.\\n]*?\\b${NEBENSATZ_ANKER}\\b|\\b${NEBENSATZ_ANKER}\\b[^.\\n]*?\\b${KI_DRITTE_PERSON}\\b`,
  'i',
);

/*
 * Zitate und indirekte Rede sind keine eigene Meldung (zweiter Fehlalarm, 08.10.2026).
 *
 * Die Antwort zitierte GitHub: jedes „ich habe es gespeichert“ sei „effectively a
 * lie“. Das Zitat enthielt die Behauptung, die Antwort selbst meldete nichts.
 *
 * 1. Text in Anfuehrungszeichen wird vor der Pruefung herausgenommen. Die
 *    Behauptung davor bleibt stehen: `Gespeichert als Lektion „deploy:api“.`
 *    wird zu `Gespeichert als Lektion .` und schlaegt weiter an (das Zitat ist
 *    dort nur der Name). Einfache Anfuehrungszeichen zaehlen nur, wenn sie
 *    nicht mitten im Wort stehen, sonst frisst "I've … it's" den halben Satz.
 * 2. Indirekte Rede: Konjunktiv "sei/seien", "sagt er", "laut …", "according to",
 *    "he said". Eine eigene Meldung benutzt keines davon.
 */
const ZITAT = /„[^“”"\n]*[“”"]|“[^”\n]*”|"[^"\n]*"|»[^«\n]*«|«[^»\n]*»|‚[^‘’\n]*[‘’]|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu;
const INDIREKTE_REDE =
  /\b(sei|seien)\b|\b(sagt|sagte|meint|meinte|schreibt|schrieb|behauptet)\s+(er|sie|es|man)\b|\blaut\b|\baccording to\b|\b(he|she|they)\s+(says?|said|claims?|claimed|wrote)\b/i;

function ohneZitate(zeile: string): string {
  return zeile.replace(ZITAT, ' ');
}

export function behauptetSpeicherung(text: string): boolean {
  return text
    .split(/\n+/)
    // Tabellenzeilen beschreiben, sie melden nichts (gemessen: 1 von 4 Fehlalarmen)
    .filter((zeile) => !zeile.trim().startsWith('|'))
    .map(ohneZitate)
    .flatMap((zeile) => zeile.split(/(?<=[.!?])\s+/))
    .some(
      (satz) =>
        !ANGEBOT.test(satz) && !REDE_UEBER_KI.test(satz) && !INDIREKTE_REDE.test(satz) && BEHAUPTUNG.some((m) => m.test(satz)),
    );
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Eintrag {
  type?: string;
  isSidechain?: boolean;
  /** Von Claude Code eingeschoben (Skill-Text, Befehlsausgabe) — nicht vom Menschen. */
  isMeta?: boolean;
  /** Herkunft eingeschobener Nachrichten, z. B. `{ kind: 'task-notification' }`. */
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
}

function bloecke(e: Eintrag): Block[] {
  const c = e.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as Block[]) : [];
}

function ergebnisText(b: Block): string {
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) {
    return (b.content as Block[]).map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  }
  return '';
}

export interface ZugBefund {
  behauptet: boolean;
  schreibaufrufe: number;
  erfolgreich: number;
  /** Belege, die die Antwort nennt, aber kein Werkzeug ausgegeben hat. */
  erfundeneBelege: string[];
}

/**
 * Kam diese Nachricht vom Menschen? Hintergrund-Meldungen und Skill-Texte stehen
 * im Protokoll ebenfalls als `user` — an ihnen darf der Zug nicht enden, sonst
 * gilt eine Speicherung kurz davor als "nicht in diesem Zug" (gemessen: 2 von 4
 * Fehlalarmen am 07.10.2026).
 */
function vomMenschen(e: Eintrag): boolean {
  if (e.type !== 'user' || e.isMeta || (e.origin?.kind && e.origin.kind !== 'human')) return false;
  const text = bloecke(e).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  if (!text) return false;
  return !/^\s*<(task-notification|local-command|command-name|system-reminder)/.test(text);
}

/**
 * Wertet den letzten Zug eines Claude-Code-Protokolls (JSONL-Zeilen) aus.
 * Der Zug beginnt nach der letzten Nachricht vom Menschen.
 */
export function pruefeZug(zeilen: string[]): ZugBefund {
  const eintraege: Eintrag[] = [];
  for (const z of zeilen) {
    if (!z.trim()) continue;
    try {
      const e = JSON.parse(z) as Eintrag;
      if (e && !e.isSidechain && (e.type === 'user' || e.type === 'assistant')) eintraege.push(e);
    } catch {
      // kaputte Zeile — ueberspringen, nie abbrechen
    }
  }

  let start = 0;
  for (let i = eintraege.length - 1; i >= 0; i--) {
    if (vomMenschen(eintraege[i])) {
      start = i + 1;
      break;
    }
  }
  const zug = eintraege.slice(start);

  const schreibIds = new Set<string>();
  let antwortText = '';
  for (const e of zug) {
    if (e.type !== 'assistant') continue;
    for (const b of bloecke(e)) {
      if (b.type === 'text' && b.text) antwortText += `${b.text}\n`;
      if (b.type === 'tool_use' && b.id && SCHREIBWERKZEUG.test(b.name ?? '')) schreibIds.add(b.id);
    }
  }

  let erfolgreich = 0;
  let werkzeugText = '';
  for (const e of zug) {
    if (e.type !== 'user') continue;
    for (const b of bloecke(e)) {
      if (b.type !== 'tool_result') continue;
      const t = ergebnisText(b);
      werkzeugText += `${t}\n`;
      if (b.tool_use_id && schreibIds.has(b.tool_use_id) && !b.is_error && !ABGEWIESEN.test(t)) erfolgreich++;
    }
  }

  const ausgegeben = new Set([...werkzeugText.matchAll(BELEG_MUSTER)].map((m) => m[1].toLowerCase()));
  const genannt = [...antwortText.matchAll(BELEG_MUSTER)].map((m) => m[1].toLowerCase());
  const erfundeneBelege = [...new Set(genannt.filter((b) => !ausgegeben.has(b)))];

  return {
    behauptet: behauptetSpeicherung(antwortText),
    schreibaufrufe: schreibIds.size,
    erfolgreich,
    erfundeneBelege,
  };
}

/**
 * Die Antwort des Stop-Hooks: leer (alles gut) oder ein `block` mit Grund, der
 * das Modell einmal zurueckschickt. `stopHookAktiv` verhindert eine Schleife —
 * ist der Zug schon eine Folge dieses Hooks, wird nie ein zweites Mal geblockt.
 */
export function stopAntwort(zeilen: string[], stopHookAktiv: boolean): string {
  if (stopHookAktiv) return '';
  const b = pruefeZug(zeilen);
  const gruende: string[] = [];
  if (b.erfundeneBelege.length) {
    gruende.push(`Die Antwort nennt Beleg ${b.erfundeneBelege.join(', ')}, den kein cachly-Werkzeug in diesem Zug ausgegeben hat.`);
  }
  if (b.behauptet && b.erfolgreich === 0) {
    gruende.push(
      b.schreibaufrufe > 0
        ? 'Die Antwort meldet eine Speicherung im Brain, aber der Schreibaufruf wurde abgewiesen oder schlug fehl.'
        : 'Die Antwort meldet eine Speicherung im Brain, aber in diesem Zug lief kein Schreibaufruf (learn_from_attempts, remember_context, session_end).',
    );
  }
  if (!gruende.length) return '';
  return JSON.stringify({
    decision: 'block',
    reason:
      `cachly Schreibbeleg: ${gruende.join(' ')} ` +
      'Speichere jetzt wirklich oder korrigiere die Aussage gegenueber dem Nutzer. ' +
      'Bezieht sich die Aussage auf eine fruehere Speicherung, sag das ausdruecklich.',
  });
}
