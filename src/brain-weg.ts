// Das gespeicherte Brain gibt es nicht mehr (404).
//
// ── Warum es das gibt (28.11.2026) ──────────────────────────────────────────
//
// Seit PR #1264 loescht die API taeglich Sofort-Test-Brains, die 14 Tage alt,
// nie benutzt und leer sind (sofort_test_abraeumer.go). Geloescht wird nur die
// Instanz. Konto und Schluessel (`cky_trial_...`) bleiben gueltig. Wer
// zurueckkommt, hat also einen gueltigen Schluessel und eine Kennung, die
// ins Leere zeigt: GET /instances/<id> antwortet 404, und jedes Werkzeug
// endete bisher mit einem nackten "cachly API error 404: not found".
//
// ── Die Regel ───────────────────────────────────────────────────────────────
//
//   Sofort-Test-Schluessel   EINMAL je Prozess POST /instances/auto. Das legt
//                            ein neues, leeres Free-Brain an (oder nennt das
//                            vorhandene) und geht mit jedem Schluessel des
//                            Kontos; der Test-Schluessel ist nicht an eine
//                            Instanz gebunden (instant_trial_handler.go).
//   Registrierter Schluessel NIE anlegen. Nur sagen, was fehlt und was zu tun ist.
//   Schlaegt /auto fehl      Meldung mit dem naechsten Schritt, kein zweiter Versuch.
//
// Die neue Kennung wird genau dort abgelegt, wo die alte herkam: in
// ~/.cachly/credentials.json, und nur wenn dort die alte Kennung stand. Kam sie
// aus der Umgebung (CACHLY_BRAIN_INSTANCE_ID), wird nichts ueberschrieben: die
// neue gilt nur fuer diesen Prozess, und die Meldung sagt, was zu aendern ist.

import { cachlyUrl } from './cachly-url.js';
import { apiFehler } from './rolle.js';
import { readInstanceId, readSavedApiKey, saveInstanceId, type CredentialsHomeOptions } from './credentials.js';

/** Das echte Praefix: generateTrialAPIKey in instant_trial_handler.go. */
export const SOFORT_TEST_PRAEFIX = 'cky_trial_';

export function istSofortTestSchluessel(schluessel: string): boolean {
  return schluessel.startsWith(SOFORT_TEST_PRAEFIX);
}

/**
 * Loeschgrund, den die API in der 404-Antwort nennt (Feld `grund`), wenn der
 * Abraeumer das Brain dieses Kontos entfernt hat. Nur dann stimmt der Satz
 * "14 Tage leer und unbenutzt, nichts verloren". Ohne das Feld bleibt die
 * Meldung neutral.
 */
export const GRUND_LEER_ABGERAEUMT = 'leer_abgeraeumt';

/** Der Befehl, der die Einrichtung noch einmal fuehrt. */
export const SETUP_BEFEHL = 'npx @cachly-dev/mcp-server@latest setup';

/** Woher die alte Kennung kam. */
export type Herkunft = 'umgebung' | 'datei' | 'prozess';

export interface NeuesBrain {
  id: string;
  name?: string;
  /** true: gerade angelegt. false: das Konto hatte schon eines, /auto hat es genannt. */
  neu: boolean;
}

export type AutoErgebnis =
  | ({ ok: true } & NeuesBrain)
  | { ok: false; status: number; detail: string };

/** Liest die Antwort von POST /instances/auto (beide Formen, siehe AutoProvision im Handler). */
export function leseAutoAntwort(roh: unknown): NeuesBrain | null {
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as { instance?: { id?: unknown; name?: unknown }; instance_id?: unknown; created?: unknown };
  const id = typeof o.instance?.id === 'string' ? o.instance.id : typeof o.instance_id === 'string' ? o.instance_id : '';
  if (!id) return null;
  const name = typeof o.instance?.name === 'string' && o.instance.name ? o.instance.name : undefined;
  return { id, ...(name ? { name } : {}), neu: o.created !== false };
}

/**
 * Tauscht die Instanz in ~/.cachly/credentials.json aus, aber NUR wenn dort
 * genau die alte Kennung neben genau diesem Schluessel steht. Sonst bleibt die
 * Datei unberuehrt. Gibt zurueck, ob geschrieben wurde. Wirft nie.
 */
export function ersetzeInstanceId(alt: string, neu: string, opts: CredentialsHomeOptions & { apiKey: string }): boolean {
  if (!neu || readSavedApiKey(opts) !== opts.apiKey || readInstanceId(opts) !== alt) return false;
  saveInstanceId(neu, opts);
  return true;
}

// ── Einmal je Prozess ────────────────────────────────────────────────────────

let versuch: Promise<AutoErgebnis> | null = null;
let hinweisGezeigt = false;
const bekanntWeg = new Map<string, string | undefined>();

/** Nur fuer Tests. */
export function _brainWegZuruecksetzen(): void {
  versuch = null;
  hinweisGezeigt = false;
  bekanntWeg.clear();
}

/** Ist diese Kennung in diesem Prozess schon als verschwunden festgestellt? */
export function istBekanntWeg(id: string): boolean {
  return bekanntWeg.has(id);
}

/** Merkt die Kennung als verschwunden, samt Loeschgrund der 404-Antwort (falls genannt). */
export function merkeWeg(id: string, grund?: string): void {
  bekanntWeg.set(id, grund);
}

/** Der gemerkte Loeschgrund zu einer verschwundenen Kennung, sonst undefined. */
export function grundWeg(id: string): string | undefined {
  return bekanntWeg.get(id);
}

/** true genau einmal je Prozess: der Hinweis geht nur an EIN Werkzeug-Ergebnis. */
export function nimmHinweisEinmal(): boolean {
  if (hinweisGezeigt) return false;
  hinweisGezeigt = true;
  return true;
}

/**
 * Ruft `auto` hoechstens einmal je Prozess. Zwei gleichzeitige Aufrufe teilen
 * sich dasselbe Ergebnis, auch ein Fehlschlag: kein zweiter Versuch.
 * Wirft nie.
 */
export function legeEinmalAn(auto: () => Promise<unknown>): Promise<AutoErgebnis> {
  if (!versuch) {
    versuch = (async (): Promise<AutoErgebnis> => {
      try {
        const brain = leseAutoAntwort(await auto());
        if (!brain) return { ok: false, status: 0, detail: 'unexpected answer' };
        return { ok: true, ...brain };
      } catch (e) {
        const info = apiFehler(e);
        const detail = e instanceof Error ? e.message : String(e);
        return { ok: false, status: info.status ?? 0, detail };
      }
    })();
  }
  return versuch;
}

// ── Die Texte (Englisch wie die uebrigen Meldungen des Servers) ──────────────

function benannt(b: NeuesBrain): string {
  return b.name ? `"${b.name}" (${b.id})` : b.id;
}

/** Der Hinweis hinter dem Werkzeug-Ergebnis, wenn ein Sofort-Test-Brain ersetzt wurde. */
export function hinweisErsetzt(alt: string, neu: NeuesBrain, herkunft: Herkunft, grund?: string): string {
  const leer = grund === GRUND_LEER_ABGERAEUMT;
  const kopf = neu.neu
    ? (leer
      ? 'Your trial Brain was removed because it stayed empty and unused for 14 days. '
        + `cachly created a new, empty Brain for you (${benannt(neu)}). `
        + 'Nothing was lost: the old one had no saved lessons.'
      : `Your trial Brain ${alt} no longer exists. cachly created a new, empty Brain for you (${benannt(neu)}).`)
    : `Your trial Brain ${alt} no longer exists${leer ? ' (removed after 14 days empty and unused)' : ''}. `
      + `Your account already has another Brain, ${benannt(neu)}, and cachly uses that one now.`;
  const fuss = herkunft === 'umgebung'
    ? ` Your setup pins the old id in CACHLY_BRAIN_INSTANCE_ID and cachly did not change it: set it to ${neu.id}, `
      + 'or this notice comes back at the next start.'
    : '';
  return `

---
cachly: ${kopf}${fuss}`;
}

/** Registrierter Schluessel: nie automatisch anlegen. */
export function meldungRegistriert(id: string): string {
  return `The Brain ${id} no longer exists in your account. `
    + `Pick another one at ${cachlyUrl('/instances', 'instance-error')} or run setup again (${SETUP_BEFEHL}).`;
}

/** Sofort-Test-Schluessel, aber /instances/auto hat nicht geklappt. */
export function meldungAnlegenFehlt(alt: string, f: { status: number; detail: string }, grund?: string): string {
  const warum = grund === GRUND_LEER_ABGERAEUMT ? ' (removed after 14 days empty and unused)' : '';
  const kopf = `The trial Brain ${alt} no longer exists${warum}, and cachly could not create a new one`;
  if (f.status === 401 || f.status === 403) {
    return `${kopf}: this key may not create Brains. Sign in once (free, no credit card): ${SETUP_BEFEHL}`;
  }
  if (f.status === 400 || f.status === 402) {
    return `${kopf}: your plan's Brain limit is reached. Free a Brain or upgrade at ${cachlyUrl('/instances', 'instance-error')}, or run ${SETUP_BEFEHL}.`;
  }
  return `${kopf} (${f.status ? `API answered ${f.status}` : 'no answer from the API'}). `
    + `Try again later, or run ${SETUP_BEFEHL}.`;
}

/** Das Feld `grund` aus der 404-Antwort (siehe GRUND_LEER_ABGERAEUMT), sonst undefined. */
export function grundAusFehler(e: unknown): string | undefined {
  return apiFehler(e).grund;
}

/** Ist das ein 404 der API? */
export function ist404(e: unknown): boolean {
  return apiFehler(e).status === 404;
}
