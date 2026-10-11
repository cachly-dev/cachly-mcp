/**
 * ══ Die Leser-Sicherung ═══════════════════════════════════════════════════
 *
 * Wie eine Sicherung im Stromkreis: Faellt der Leser (POST /api/v1/rerank)
 * mehrmals hintereinander aus, wird er eine Weile gar nicht mehr gefragt.
 * Danach gibt es EINEN Versuch. Gelingt er, ist alles wieder normal; sonst
 * folgt die naechste Pause.
 *
 * ── Warum (gemessen 11.10.2026) ───────────────────────────────────────────
 *
 * Der Leser laeuft auf CPU auf einem Bau-Server. Unter CI-Last brauchte er
 * fuer 25 Texte 2,1 bis 2,3 s Serverzeit. In 6 von 6 gemessenen Prompts kam
 * seine Antwort nicht binnen LESER_ZEITLIMIT_MS (2,5 s): Jeder Prompt wartete
 * 2,5 s und bekam am Ende trotzdem nur die lokale Ordnung. Ohne Leser antwortet
 * die Einblendung in 0,6 bis 1,0 s. Die Sicherung macht aus "2,5 s umsonst
 * warten, bei jedem Prompt" ein "3 x warten, dann 10 Minuten nicht".
 *
 * ── Eine Quelle fuer beide Wege ───────────────────────────────────────────
 *
 *   Hook (einblendung.ts): Jeder Prompt ist ein eigener Prozess. Der Zustand
 *     liegt deshalb in einer kleinen Datei je Instanz (dateiSpeicher).
 *   MCP-Server (leser.ts, smart_recall): ein langlebiger Prozess. Der Zustand
 *     bleibt im Speicher (speicherImProzess).
 *
 * Beide benutzen dieselbe Klasse, dieselben Schwellen und dieselbe Einteilung
 * der Antworten (leserErgebnisAusStatus / leserErgebnisAusFehler).
 *
 * ── Was als Fehlschlag zaehlt ─────────────────────────────────────────────
 *
 *   Fehlschlag:   Zeitgrenze, Netzfehler, HTTP 5xx.
 *   Abgeschaltet: HTTP 503 heisst "kein Dienst dahinter" oder "Sicherung der
 *                 API offen". Dann sofort die volle Pause, ohne drei Versuche.
 *                 (So hielt es leser.ts schon vorher, jetzt auch der Hook.)
 *   Erfolg:       gueltige Punkte. Setzt die Sicherung zurueck.
 *   Neutral:      alles andere (4xx wie 429 vom Limiter, kaputte Antwort).
 *                 Kostet keine Wartezeit, aendert den Zustand nicht.
 *
 * Abschalten fuer Messlaeufe: CACHLY_LESER_SICHERUNG=aus (auch 0/off/false).
 * Dann wird der Leser bei jedem Aufruf gefragt, und der Zustand bleibt
 * unberuehrt.
 *
 * Nur Node-Bordmittel: Diese Datei reist im Hook-Buendel ohne node_modules.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Nach so vielen Fehlschlaegen IN FOLGE springt die Sicherung.
 *
 * Drei, weil ein einzelner Ausreisser (ein langsamer Prompt waehrend eines
 * Bauvorgangs) den Leser nicht abschalten soll. Drei Ausfaelle kosten
 * hoechstens 3 x 2,5 s = 7,5 s, bevor die Sicherung greift.
 */
export const LESER_SICHERUNG_FEHLSCHLAEGE = 3;

/**
 * So lange wird der Leser nach dem Springen nicht gefragt: 10 Minuten.
 *
 * Dieselbe Zahl wie die 503-Sperre, die leser.ts seit Einfuehrung des Lesers
 * hat. Ein CI-Lauf auf dem Bau-Server dauert typisch einige Minuten; nach
 * 10 Minuten lohnt ein neuer Versuch. Ein Versuch kostet hoechstens 2,5 s,
 * also im schlechtesten Fall 2,5 s je 10 Minuten statt 2,5 s je Prompt.
 */
export const LESER_SICHERUNG_PAUSE_MS = 10 * 60_000;

/** Wie ein Leseraufruf ausging — die Einteilung, die die Sicherung braucht. */
export type LeserErgebnis = 'erfolg' | 'fehlschlag' | 'abgeschaltet' | 'neutral';

/** Was die Sicherung sich merkt. */
export interface SicherungsZustand {
  /** Fehlschlaege in Folge seit dem letzten Erfolg. */
  fehlschlaege: number;
  /** Bis zu diesem Zeitpunkt (ms seit 1970) wird nicht gefragt. 0 = keine Pause. */
  offenBis: number;
}

/** Wo der Zustand liegt: im Speicher (MCP-Server) oder in einer Datei (Hook). */
export interface SicherungsSpeicher {
  lies(): SicherungsZustand;
  schreib(z: SicherungsZustand): void;
}

const RUHE: SicherungsZustand = { fehlschlaege: 0, offenBis: 0 };

/** Ist die Sicherung per Umgebung abgeschaltet? (Messlaeufe) */
export function sicherungAbgeschaltet(): boolean {
  return ['0', 'off', 'aus', 'false'].includes(String(process.env.CACHLY_LESER_SICHERUNG ?? '').toLowerCase());
}

/** HTTP-Status -> Ergebnis. 2xx ist hier noch kein Erfolg: erst gueltige Punkte sind einer. */
export function leserErgebnisAusStatus(status: number): LeserErgebnis {
  if (status === 503) return 'abgeschaltet';
  if (status >= 500) return 'fehlschlag';
  return 'neutral';
}

/**
 * Geworfener Fehler -> Ergebnis. Zeitgrenze und Netzfehler zaehlen; ein
 * kaputtes JSON (SyntaxError) kam schnell an und kostet keine Wartezeit.
 */
export function leserErgebnisAusFehler(fehler: unknown): LeserErgebnis {
  return (fehler as { name?: unknown } | null)?.name === 'SyntaxError' ? 'neutral' : 'fehlschlag';
}

function gueltig(z: unknown): SicherungsZustand {
  const o = (z ?? {}) as Partial<Record<keyof SicherungsZustand, unknown>>;
  const zahl = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return { fehlschlaege: Math.floor(zahl(o.fehlschlaege)), offenBis: zahl(o.offenBis) };
}

export class LeserSicherung {
  constructor(
    private readonly speicher: SicherungsSpeicher,
    // Date.now erst beim Aufruf nachschlagen, nicht beim Bau festhalten:
    // die Sicherung des MCP-Servers lebt so lange wie der Prozess.
    private readonly jetzt: () => number = () => Date.now(),
  ) {}

  /**
   * Offen = gerade in der Pause. Ohne Nebenwirkung — zum Nachsehen.
   * Ein Zeitpunkt weiter als eine Pause in der Zukunft gilt als kaputt
   * (falsche Uhr, verfaelschte Datei) und sperrt nicht.
   */
  offen(): boolean {
    if (sicherungAbgeschaltet()) return false;
    const z = this.speicher.lies();
    if (z.fehlschlaege < LESER_SICHERUNG_FEHLSCHLAEGE) return false;
    const t = this.jetzt();
    return t < z.offenBis && z.offenBis - t <= LESER_SICHERUNG_PAUSE_MS;
  }

  /**
   * Darf der Leser jetzt gefragt werden? Genau EIN Aufruf je Leseranfrage.
   *
   * Ist die Pause vorbei, kommt genau ein Versuch durch: die Pause wird sofort
   * neu gespannt, damit gleichzeitige Aufrufe nicht alle warten. Gelingt der
   * Versuch, setzt melde('erfolg') alles zurueck. Zwei Prozesse, die die Datei
   * im selben Augenblick lesen, machen schlimmstenfalls einen Versuch zu viel.
   */
  darfFragen(): boolean {
    if (sicherungAbgeschaltet()) return true;
    if (this.offen()) return false;
    const z = this.speicher.lies();
    if (z.fehlschlaege >= LESER_SICHERUNG_FEHLSCHLAEGE) {
      this.speicher.schreib({ fehlschlaege: z.fehlschlaege, offenBis: this.jetzt() + LESER_SICHERUNG_PAUSE_MS });
    }
    return true;
  }

  /** Den Ausgang eines Aufrufs melden. */
  melde(ergebnis: LeserErgebnis): void {
    if (ergebnis === 'neutral' || sicherungAbgeschaltet()) return;
    const z = this.speicher.lies();
    if (ergebnis === 'erfolg') {
      // Im Normalbetrieb steht hier schon RUHE — dann nichts schreiben.
      if (z.fehlschlaege !== 0 || z.offenBis !== 0) this.speicher.schreib({ ...RUHE });
      return;
    }
    const fehlschlaege = ergebnis === 'abgeschaltet'
      ? Math.max(z.fehlschlaege + 1, LESER_SICHERUNG_FEHLSCHLAEGE)
      : z.fehlschlaege + 1;
    this.speicher.schreib({
      fehlschlaege,
      offenBis: fehlschlaege >= LESER_SICHERUNG_FEHLSCHLAEGE ? this.jetzt() + LESER_SICHERUNG_PAUSE_MS : 0,
    });
  }
}

// ── Der Anruf hinter der Sicherung — fuer beide Wege derselbe ───────────────

/** Wie ein Leseranruf ausging, aus Sicht des Aufrufers. */
export type LeserAntwort =
  | { art: 'punkte'; scores: number[]; provider: string; ms: number }
  /** Sicherung offen: der Leser wurde gar nicht gefragt (0 ms). */
  | { art: 'uebersprungen' }
  /** Gefragt, aber keine brauchbare Antwort (Zeitgrenze, Fehler, kaputte Punkte). */
  | { art: 'ohne' };

export interface LeserAnruf {
  /** Voller Endpunkt, z. B. https://api.cachly.dev/api/v1/rerank */
  url: string;
  jwt: string;
  frage: string;
  texte: string[];
  /** Die API waehlt damit, WELCHER Leser liest (eigener Dienst oder Jev). */
  instanceId?: string;
  zeitlimitMs: number;
  fetchFn?: typeof fetch;
  /** Nur fuer Messlaeufe (X-Admin-Key gegen den Embed-Limiter). */
  zusatzKopf?: Record<string, string>;
}

const OHNE: LeserAntwort = { art: 'ohne' };

/**
 * POST /api/v1/rerank, bewacht von der Sicherung. Wirft nie.
 * Genau ein darfFragen() und hoechstens ein melde() je Aufruf.
 */
export async function frageLeser(anruf: LeserAnruf, sicherung: LeserSicherung): Promise<LeserAntwort> {
  if (!sicherung.darfFragen()) return { art: 'uebersprungen' };
  const f = anruf.fetchFn ?? fetch;
  try {
    const res = await f(anruf.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${anruf.jwt}`,
        ...(anruf.zusatzKopf ?? {}),
      },
      body: JSON.stringify({ query: anruf.frage, texts: anruf.texte, instance_id: anruf.instanceId }),
      signal: AbortSignal.timeout(anruf.zeitlimitMs),
    });
    if (!res.ok) {
      sicherung.melde(leserErgebnisAusStatus(res.status));
      return OHNE;
    }
    const j = await res.json() as { scores?: unknown; provider?: unknown; ms?: unknown };
    const scores = Array.isArray(j?.scores) ? j.scores : null;
    if (!scores || scores.length !== anruf.texte.length || !scores.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      return OHNE; // kaputte Antwort: kam schnell, zaehlt nicht
    }
    sicherung.melde('erfolg');
    return {
      art: 'punkte',
      scores: scores as number[],
      provider: typeof j.provider === 'string' ? j.provider : '?',
      ms: Number(j.ms) || 0,
    };
  } catch (fehler) {
    sicherung.melde(leserErgebnisAusFehler(fehler));
    return OHNE;
  }
}

/** Zustand im Speicher — fuer den langlebigen MCP-Server. */
export function speicherImProzess(): SicherungsSpeicher {
  let z: SicherungsZustand = { ...RUHE };
  return {
    lies: () => ({ ...z }),
    schreib: (neu) => { z = gueltig(neu); },
  };
}

/**
 * Zustand in einer Datei — fuer den Hook, der je Prompt neu startet.
 *
 * Fehlende oder kaputte Datei = Ruhe (normaler Betrieb). Geschrieben wird
 * ueber eine Zwischendatei und Umbenennen, damit ein gleichzeitiger Leser nie
 * eine halbe Datei sieht. Scheitert das Schreiben, laeuft der Hook trotzdem —
 * die Sicherung ist bestes Bemuehen, kein Muss.
 */
export function dateiSpeicher(pfad: string): SicherungsSpeicher {
  return {
    lies: () => {
      try { return gueltig(JSON.parse(readFileSync(pfad, 'utf8'))); } catch { return { ...RUHE }; }
    },
    schreib: (neu) => {
      const zwischen = `${pfad}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(pfad), { recursive: true });
        writeFileSync(zwischen, JSON.stringify(gueltig(neu)), { mode: 0o600 });
        renameSync(zwischen, pfad);
      } catch {
        try { rmSync(zwischen, { force: true }); } catch { /* bestes Bemuehen */ }
      }
    },
  };
}
