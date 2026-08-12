// Kostprobe — gesperrte Werkzeuge dürfen ein paar Mal echt laufen.
//
// ─── DER ANLASS ──────────────────────────────────────────────────────────────
//
// Gemessen am 11.08.2026 in mcp_events: `premium_gate_hit` ist 36-mal gefeuert,
// von genau EINER Person — dem Entwickler des Produkts selbst, zwischen dem
// 30.06. und dem 08.08. Er hat nicht aufgerüstet. Bei seinem eigenen Produkt,
// wo Geld nicht das Hindernis ist.
//
// Das ist die härteste Zahl, die es zur Preisfrage gibt: Der intensivste
// Nutzer, den cachly je hatte, stand 36-mal vor der Schranke und ging jedes
// Mal weiter. Nicht weil die Funktionen schlecht wären — sondern weil er nie
// gesehen hat, was sie an SEINEN Daten tun.
//
// Die Schranke gab eine Verkaufsansage. Nie eine Kostprobe.
// Man vermisst nicht, was man nie hatte.
//
// ─── DIE REGEL ───────────────────────────────────────────────────────────────
//
// Jedes gesperrte Werkzeug darf auf der Gratis-Stufe KOSTPROBEN_JE_WERKZEUG-mal
// vollständig laufen. Echtes Ergebnis, keine gekürzte Fassung. Erst danach
// kommt die Schranke — und dann mit einer Zahl statt einem Versprechen:
// "Das hat dir schon 3-mal geholfen."
//
// Je Werkzeug einzeln gezählt, nicht als Gesamtbudget. Wer causal_trace
// dreimal nutzt, soll trotzdem brain_predict noch kennenlernen dürfen; ein
// gemeinsamer Topf würde beim ersten Werkzeug aufgebraucht.
//
// ─── WAS DIESE ZÄHLUNG NICHT KANN ────────────────────────────────────────────
//
// Sie liegt lokal in ~/.cachly/ und gilt damit je Rechner. Wer neu installiert
// oder auf einem zweiten Rechner arbeitet, bekommt neue Kostproben. Das ist
// bewusst in Kauf genommen: Eine serverseitige Zählung wäre genauer, bräuchte
// aber eine Migration und einen neuen Endpunkt — und für eine Kostprobe ist
// großzügig der richtige Fehler. Wer sie mehrfach aufbraucht, hat das Werkzeug
// mehrfach erlebt; das ist kein Verlust, das ist der Zweck.
//
// Zu messen ist der Erfolg an einer Zahl: heute 36 Ansagen, 0 Aufrüstungen.
// Danach müsste das Verhältnis von `premium_taste_used` zu `premium_gate_hit`
// zeigen, ob aus Erleben Interesse wird.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** So oft darf jedes gesperrte Werkzeug auf der Gratis-Stufe echt laufen. */
export const KOSTPROBEN_JE_WERKZEUG = 3;

export function defaultKostprobePath(): string {
  return join(homedir(), '.cachly', 'kostproben.json');
}

type Zaehler = Record<string, number>;

function lesen(path: string): Zaehler {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Nur Zahlen übernehmen — eine beschädigte Datei darf nicht dazu führen,
      // dass jemand dauerhaft freien Zugang bekommt oder dauerhaft keinen.
      const out: Zaehler = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {}; // beschädigt → wie leer behandeln
  }
}

/** Wie oft wurde dieses Werkzeug auf diesem Rechner schon gekostet? */
export function kostprobenVerbraucht(werkzeug: string, path: string = defaultKostprobePath()): number {
  return lesen(path)[werkzeug] ?? 0;
}

/** Sind noch Kostproben übrig? */
export function kostprobeUebrig(werkzeug: string, path: string = defaultKostprobePath()): boolean {
  return kostprobenVerbraucht(werkzeug, path) < KOSTPROBEN_JE_WERKZEUG;
}

/**
 * Verbraucht eine Kostprobe und liefert die neue Anzahl.
 * Schlägt das Schreiben fehl, wird trotzdem hochgezählt zurückgegeben — der
 * Aufruf darf nie an einem Dateisystemproblem scheitern. Im schlimmsten Fall
 * bekommt jemand eine Kostprobe mehr; das ist der harmlosere Fehler.
 */
export function kostprobeVerbrauchen(werkzeug: string, path: string = defaultKostprobePath()): number {
  const alle = lesen(path);
  const neu = (alle[werkzeug] ?? 0) + 1;
  try {
    alle[werkzeug] = neu;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(alle, null, 2) + '\n', 'utf-8');
  } catch {
    /* nie werfen */
  }
  return neu;
}

/**
 * Der Hinweis NACH einer Kostprobe. Bewusst kurz und ohne Druck — das Ergebnis
 * steht darüber und soll wirken, nicht der Text.
 */
export function kostprobeHinweis(werkzeug: string, verbraucht: number, upgradeUrl: string): string {
  const uebrig = Math.max(0, KOSTPROBEN_JE_WERKZEUG - verbraucht);
  if (uebrig > 0) {
    return `\n\n_Kostprobe: \`${werkzeug}\` ist eine Premium-Funktion. ` +
      `Noch ${uebrig} ${uebrig === 1 ? 'freier Lauf' : 'freie Läufe'} auf diesem Rechner._`;
  }
  return `\n\n_Das war deine letzte Kostprobe von \`${werkzeug}\`. ` +
    `Weiter geht es hier: ${upgradeUrl}_`;
}

/**
 * Die Schranke, wenn die Kostproben aufgebraucht sind. Sie nennt eine ZAHL
 * statt eines Versprechens — "so oft hat es dir schon geholfen" ist ein
 * Argument, "eine Premium-Funktion" ist keines.
 */
export function schrankeNachKostproben(
  werkzeug: string,
  pitch: string,
  upgradeUrl: string,
): string {
  return [
    `🔒 **\`${werkzeug}\`** — deine ${KOSTPROBEN_JE_WERKZEUG} Kostproben sind aufgebraucht.`,
    ``,
    `Es hat dir hier schon ${KOSTPROBEN_JE_WERKZEUG}-mal geantwortet: ${pitch}`,
    ``,
    `Dein Gratis-Gedächtnis behält alles andere — Abruf, Lernen, Sitzungen, Kausalgraph. Für immer.`,
    `Weiter mit der tieferen Schicht → ${upgradeUrl}`,
  ].join('\n');
}
