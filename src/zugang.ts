// Zugang sichern — ohne Schluessel zuerst der Sofort-Test, erst danach die
// Browser-Anmeldung.
//
// ── Warum es diese Datei gibt (11.10.2026) ──────────────────────────────────
//
// Gemessen in der Produktions-Datenbank, 60 Tage: Jeder Start ohne Schluessel
// ergab `first_call_no_jwt` und direkt danach `device_flow_started`, also die
// Browser-Anmeldung. Am 19./20.09. kam dazu `device_browser_failed` mit dem
// Grund `enoent` (kein Browser: Container, WSL, SSH) und danach
// `device_flow_failed` mit `timeout`. Von 8 solchen Starts kam 1 durch. Ueber
// das Claude-Code-Plugin wurde seit dem 28.08. KEIN einziges Konto angelegt.
//
// Dabei gab es den Sofort-Test seit dem 28.08. (sofort-test.ts). Er sass nur
// an der falschen Stelle: in `resolveDefaultInstanceId()`. Die wird erst
// erreicht, wenn schon ein Schluessel da ist. `handleTool()` prueft vorher
// `if (!JWT)` und startete sofort die Browser-Anmeldung. Fuer genau den
// Nutzer, fuer den der Sofort-Test gebaut war, war er unerreichbar.
//
// Zweite Luecke im selben Zweig: Griff der Sofort-Test doch, setzte er nur
// den Schluessel im Prozess und die Instanz. Die Einbettungen kannten den
// Schluessel nicht, und ~/.claude/mcp.json bekam ihn nicht.
//
// ── Was jetzt gilt ──────────────────────────────────────────────────────────
//
// 1. Ein vorhandener Schluessel wird benutzt — auch ein falscher. Ein stiller
//    zweiter Account waere schlimmer als eine Fehlermeldung: der Nutzer suchte
//    seine Daten im falschen Brain.
// 2. Zeigt eine Kennung in UUID-Form auf ein bestehendes Brain
//    (CACHLY_BRAIN_INSTANCE_ID oder instance_id im Aufruf), gibt es ebenfalls
//    keinen Sofort-Test. Der Nutzer hat ein Konto; er braucht die Anmeldung,
//    kein zweites Brain. Erfundene Werte wie "default" zaehlen nicht.
// 3. Sonst: Sofort-Test. Gelingt er, wird der Schluessel GENAUSO vollstaendig
//    abgelegt wie nach der Browser-Anmeldung, und der Werkzeugaufruf laeuft.
// 4. Misslingt er, startet die Browser-Anmeldung wie bisher.

import type { SofortTest } from './sofort-test.js';
import type { FunnelEventName } from './telemetry-types.js';
import { istPlatzhalter } from './credentials.js';

/** Die Ablagen, in die ein neuer Schluessel muss. Dieselben wie nach der Browser-Anmeldung. */
export interface ZugangsAblagen {
  /** Der Schluessel im laufenden Prozess (`JWT` in index.ts). */
  setzeSchluessel: (key: string) => void;
  /** Die Einbettungen haben ihre eigene Kopie (embeddings.ts). */
  setEmbedJwt: (key: string) => void;
  /** ~/.cachly/credentials.json — dort lesen die Hooks. */
  saveApiKey: (key: string) => void;
  /** ~/.claude/mcp.json und die Editor-Konfigurationen. */
  persistApiKeyToConfig: (key: string) => Promise<void>;
  /** Die Instanz im laufenden Prozess (`_defaultInstanceId` in index.ts). */
  merkeInstanz: (id: string) => void;
  /** Die Instanz in den Editor-Konfigurationen und neben dem Schluessel in ~/.cachly/credentials.json (dort lesen die Hooks). */
  persistInstanceIdToConfig: (id: string) => Promise<void>;
}

export interface ZugangsAufruf {
  /** Der Schluessel, mit dem der Prozess gerade arbeitet. Leer = keiner. */
  schluessel: string;
  /** Eine konfigurierte Instanz (CACHLY_BRAIN_INSTANCE_ID). Leer = keine. */
  konfigurierteInstanz: string;
  /** instance_id aus dem Werkzeugaufruf. */
  aufrufInstanz?: unknown;
  /** Name des Werkzeugs, nur fuer das Ereignis. */
  werkzeugName: string;
  holeSofortTest: () => Promise<SofortTest | null>;
  ablagen: ZugangsAblagen;
  meldeEreignis: (event: FunnelEventName, extra?: Record<string, unknown>) => void;
  /** Fuehrt den Werkzeugaufruf aus. Wird erst aufgerufen, wenn der Schluessel gesetzt ist. */
  werkzeug: () => Promise<string>;
  /** Startet die Browser-Anmeldung (der bisherige Weg, unveraendert). */
  anmelden: () => Promise<string>;
  /** Zeile fuer das Editor-Protokoll. Standard: stderr. */
  protokoll?: (zeile: string) => void;
}

/** Ein Wert zaehlt nur, wenn er weder leer noch ein nicht ersetzter Platzhalter ist. */
export function echterWert(wert: unknown): string {
  if (typeof wert !== 'string') return '';
  const w = wert.trim();
  return w && !istPlatzhalter(w) ? w : '';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Zeigt der Wert auf ein bestehendes Brain? Nur eine Kennung in UUID-Form.
 *
 * Modelle uebergeben oft eine erfundene oder aus einem fremden CLAUDE.md
 * abgeschriebene instance_id ("default", "my-brain"). Zaehlte die, landete ein
 * brandneuer Nutzer wieder in der Browser-Anmeldung.
 */
export function istInstanzKennung(wert: unknown): boolean {
  return UUID.test(echterWert(wert));
}

/**
 * Der Hinweis am ersten Ergebnis. Er geht an den Assistenten; deshalb steht
 * die Bitte, ihn weiterzugeben, im Text selbst.
 *
 * Es gibt (Stand 11.10.2026) KEINEN Weg, ein Test-Brain auf ein Konto zu
 * uebertragen. `autopilot` meldet neu an und legt ein eigenes Brain an. Das
 * steht im Hinweis, damit niemand Daten erwartet, die nicht mitkommen.
 */
export function sofortTestHinweis(test: SofortTest): string {
  const bis = test.tarifEndetAm && /^\d{4}-\d{2}-\d{2}/.test(test.tarifEndetAm)
    ? `Dev tier until ${test.tarifEndetAm.slice(0, 10)}`
    : '14 days of Dev tier';
  return [
    '',
    '',
    '---',
    `ℹ️ **cachly:** no API key was found, so a test Brain was created on EU servers — no sign-up. `
      + `Tell the user once: it keeps working without an account (${bis}, then the free tier, same key). `
      + 'To use their own cachly account instead, run `npx @cachly-dev/mcp-server@latest autopilot` — '
      + 'that account gets a new Brain; lessons from this test Brain do not move over yet.',
  ].join('\n');
}

// Laufender Versuch je Prozess. Zwei gleichzeitige erste Aufrufe teilen sich
// EINEN Sofort-Test; sonst holte der erste ihn, und der zweite startete
// nebenher eine Browser-Anmeldung, weil holeSofortTest beim zweiten Mal null
// liefert.
let laufenderVersuch: Promise<SofortTest | null> | null = null;

/** Nur fuer Tests. */
export function _zugangZuruecksetzen(): void {
  laufenderVersuch = null;
}

/**
 * Bedient einen Werkzeugaufruf je nach Zugang. Wirft nur, was `werkzeug` oder
 * `anmelden` werfen.
 */
export async function sichereZugang(a: ZugangsAufruf): Promise<string> {
  // 1. Vorhandener Schluessel, auch ein falscher: kein zweites Konto.
  if (a.schluessel) return a.werkzeug();

  // 2. Eine Kennung in UUID-Form zeigt auf ein bestehendes Brain: anmelden
  //    statt neu anlegen. "default" oder "my-brain" zeigen auf nichts.
  if (istInstanzKennung(a.konfigurierteInstanz) || istInstanzKennung(a.aufrufInstanz)) return a.anmelden();

  // 3. Sofort-Test, hoechstens einer je Prozess.
  const eigenerVersuch = laufenderVersuch === null;
  if (eigenerVersuch) laufenderVersuch = a.holeSofortTest();
  const test = await laufenderVersuch;

  // 4. Kein Test: die Browser-Anmeldung wie bisher.
  if (!test) return a.anmelden();

  // Ein gleichzeitiger Aufruf hat denselben Test schon abgelegt.
  if (!eigenerVersuch) return a.werkzeug();

  // Erst die Ablagen im Prozess, ohne await dazwischen. So sieht ein
  // gleichzeitiger Aufruf den Schluessel, sobald er weiterlaeuft.
  a.ablagen.setzeSchluessel(test.apiKey);
  a.ablagen.setEmbedJwt(test.apiKey);
  a.ablagen.saveApiKey(test.apiKey);
  a.ablagen.merkeInstanz(test.instanzId);
  // Nacheinander: persistInstanceIdToConfig aendert nur einen Eintrag, den
  // persistApiKeyToConfig erst anlegt. Beide werfen nie.
  await a.ablagen.persistApiKeyToConfig(test.apiKey);
  await a.ablagen.persistInstanceIdToConfig(test.instanzId);

  a.meldeEreignis('instant_trial_started', { tool: a.werkzeugName, instance_id: test.instanzId });
  (a.protokoll ?? ((z: string) => { process.stderr.write(z); }))(
    `\ncachly: no API key found — created a test Brain on EU servers (instance ${test.instanzId}).\n`
    + 'cachly: the key is stored in ~/.cachly/credentials.json. Own account: npx @cachly-dev/mcp-server@latest autopilot\n\n',
  );

  const ergebnis = await a.werkzeug();
  return ergebnis + sofortTestHinweis(test);
}
