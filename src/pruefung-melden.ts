/**
 * „Ich habe nachgeprüft" — die Gegenrichtung zu „Lesen ist kein Prüfen".
 *
 * ── Warum es das gibt ─────────────────────────────────────────────────────
 *
 * Bis 0.10.165 setzte JEDER Abruf `verified_at` auf jetzt. Das Feld heisst
 * „geprueft" und wurde von einer Handlung gesetzt, die nichts nachprueft.
 * Das wurde behoben — und damit entstand ein zweites Problem, das wir am
 * 05.09.2026 beim Messen von Stufe 6 gefunden haben:
 *
 *   `verified_at` laesst sich seither NUR NOCH beim Schreiben setzen.
 *
 * Jede Lektion verfaellt also unaufhaltsam, und der einzige Ausweg ist, sie
 * vollstaendig neu zu schreiben — was `grund` verlangt, also eine Begruendung
 * fuer eine Aenderung, die gar keine ist. Die ehrliche Haelfte war gebaut,
 * die brauchbare fehlte.
 *
 * ── Was hier NICHT passiert ───────────────────────────────────────────────
 *
 * Der Server fuehrt den gespeicherten Befehl NIEMALS selbst aus. Ein Befehl,
 * den ein Server aus einem GETEILTEN Speicher heraus ausfuehrt, ist eine
 * Hintertuer: wer schreiben darf, fuehrt dann auf fremder Maschine aus.
 *
 * Hier wird nur das ERGEBNIS entgegengenommen, das ein Mensch oder ein Agent
 * mitbringt, der ohnehin Rechte auf dieser Maschine hat.
 *
 * ── Und was ein Fehlschlag NICHT tut ──────────────────────────────────────
 *
 * Er loescht nichts. Eine Lektion, deren Pruefung fehlschlaegt, ist nicht
 * automatisch falsch — vielleicht war der Dienst nur gerade aus. Sie wird
 * MARKIERT, der Abruf warnt, und ein Mensch entscheidet, was sie ersetzt.
 */

/** Wie die Meldung hereinkommt. */
export interface Pruefmeldung {
  topic?: unknown;
  /** Hat die Pruefung die Behauptung bestaetigt? */
  haelt?: unknown;
  /** Womit geprueft wurde — der Befehl, der wirklich lief. */
  geprueft_mit?: unknown;
  /** Was stattdessen gefunden wurde, wenn es nicht haelt. */
  befund?: unknown;
}

/** Was in der Lektion landet. */
export interface Pruefeintrag {
  topic: string;
  haelt: boolean;
  ts: string;
  geprueft_mit?: string;
  befund?: string;
}

export interface Geprueft {
  ok: true;
  eintrag: Pruefeintrag;
}
export interface Abgelehnt {
  ok: false;
  grund: string;
}

/**
 * Wie lang ein mitgeschickter Befehl hoechstens sein darf.
 *
 * Nicht Willkuer: der Befehl wird spaeter im Abruf ANGEZEIGT, und der Abruf
 * hat ein Zeichenbudget. Dieselbe Grenze wie beim Pruefhinweis im Badge.
 */
export const BEFEHL_GRENZE = 200;
/** Ein Befund ist eine Zeile Klartext, kein Protokoll. */
export const BEFUND_GRENZE = 400;

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Prueft die Meldung, bevor sie irgendetwas veraendert.
 *
 * Streng bei `haelt`: ein fehlendes Feld wird NICHT als `false` gelesen und
 * auch nicht als `true`. Beides waere geraten, und geraten wird hier nicht —
 * die eine Richtung setzt eine Lektion faelschlich auf frisch, die andere
 * markiert sie faelschlich als gefallen.
 */
export function pruefeMeldung(
  eingabe: Pruefmeldung,
  jetzt: string,
): Geprueft | Abgelehnt {
  const topic = text(eingabe.topic);
  if (!topic) {
    return { ok: false, grund: '`topic` fehlt — welche Lektion wurde geprueft?' };
  }

  if (typeof eingabe.haelt !== 'boolean') {
    return {
      ok: false,
      grund: '`haelt` muss true oder false sein. Ohne diese Angabe waere die '
        + 'Meldung eine Vermutung: einmal geraten macht sie die Lektion frisch, '
        + 'andersherum markiert sie eine richtige Lektion als gefallen.',
    };
  }
  const haelt = eingabe.haelt;

  const befehl = text(eingabe.geprueft_mit);
  if (befehl.length > BEFEHL_GRENZE) {
    return {
      ok: false,
      grund: `\`geprueft_mit\` ist ${befehl.length} Zeichen lang, erlaubt sind `
        + `${BEFEHL_GRENZE}. Der Befehl wird im Abruf angezeigt und hat dort ein Budget.`,
    };
  }
  if (befehl.includes('\n')) {
    return { ok: false, grund: '`geprueft_mit` muss EIN Befehl in einer Zeile sein.' };
  }

  const befund = text(eingabe.befund);
  if (befund.length > BEFUND_GRENZE) {
    return {
      ok: false,
      grund: `\`befund\` ist ${befund.length} Zeichen lang, erlaubt sind `
        + `${BEFUND_GRENZE}. Eine Zeile Klartext, kein Protokoll.`,
    };
  }

  // Ein Fehlschlag ohne Befund ist eine Behauptung ohne Inhalt. Wer meldet,
  // dass etwas nicht mehr stimmt, muss sagen, was er stattdessen gesehen hat
  // — sonst kann die naechste Sitzung damit nichts anfangen und die Warnung
  // ist nur Laerm.
  if (!haelt && !befund) {
    return {
      ok: false,
      grund: 'Ein Fehlschlag braucht `befund`: was hast du stattdessen gesehen? '
        + 'Eine Warnung ohne Inhalt ist Laerm, und die naechste Sitzung kann '
        + 'nichts damit anfangen.',
    };
  }

  const eintrag: Pruefeintrag = { topic, haelt, ts: jetzt };
  if (befehl) eintrag.geprueft_mit = befehl;
  if (befund) eintrag.befund = befund;
  return { ok: true, eintrag };
}

/**
 * Was die Meldung an der gespeicherten Lektion aendert.
 *
 * Getrennt von der Pruefung, damit sich beides einzeln testen laesst — und
 * damit sichtbar bleibt, wie WENIG hier passiert. Der Fehlschlag setzt eine
 * Markierung; er loescht nichts, ueberschreibt nichts und aendert den Text
 * der Lektion nicht.
 */
export function wendeAn(
  lektion: Record<string, unknown>,
  eintrag: Pruefeintrag,
): Record<string, unknown> {
  const neu = { ...lektion };
  if (eintrag.haelt) {
    neu.verified_at = eintrag.ts;
    neu.confidence = 1.0;
    // Eine bestandene Pruefung hebt eine fruehere gefallene auf. Sonst
    // warnte der Abruf ewig weiter, obwohl jemand nachgesehen hat.
    delete neu.pruefung_gefallen_am;
    delete neu.pruefung_befund;
  } else {
    neu.pruefung_gefallen_am = eintrag.ts;
    neu.pruefung_befund = eintrag.befund;
    // `verified_at` bleibt, wie es war. Ein Fehlschlag macht die Lektion
    // nicht juenger und nicht aelter — er macht sie fraglich.
  }
  const spur = Array.isArray(neu.pruefspur) ? [...neu.pruefspur] : [];
  spur.push(eintrag);
  // Die letzten zwanzig genuegen: wer oefter prueft, will die Entwicklung
  // sehen, nicht das Archiv.
  neu.pruefspur = spur.slice(-20);
  return neu;
}
