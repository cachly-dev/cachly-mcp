// Sofort-Test — ein neuer Nutzer ist nach der Installation fertig, ohne einen
// einzigen weiteren Schritt.
//
// ── Warum es das gibt (28.08.2026) ──────────────────────────────────────────
//
// Wer das Claude-Code-Plugin installiert, hat danach: kein Konto, keine
// Brain-Kennung, keinen Schluessel. Der Server lief zwar, konnte aber nichts —
// und die Aufloesung in index.ts stieg an genau einer Zeile aus:
//
//     if (!JWT) return '';
//
// Wer schon angemeldet war und nur keine Instanz hatte, bekam automatisch
// eine. Wer NICHTS hatte, bekam nichts. Also genau der neue Nutzer, dem das
// Plugin die Einrichtung abnehmen sollte.
//
// Das Gegenstueck gibt es seit Monaten: POST /auth/instant-trial legt ein
// anonymes Konto samt Schluessel und Instanz an, ohne Anmeldung, in unter
// einer Sekunde. Die VS-Code-Erweiterung benutzt es seit Juli. Hier wird
// derselbe Weg gegangen.
//
// ── Was der Nutzer davon merkt ──────────────────────────────────────────────
//
// Nichts. Er ruft ein Werkzeug auf, es antwortet. Kein Formular, kein
// Schluessel, kein Kopieren. Nach 14 Tagen endet der Dev-Tarif, nicht der
// Zugang; wer bleiben will, verknuepft sein Konto.
//
// ── Was ausdruecklich NICHT passiert ────────────────────────────────────────
//
// Es wird KEIN Test geholt, wenn schon ein Schluessel da ist — auch kein
// abgelaufener oder falscher. Ein stiller zweiter Account waere schlimmer als
// eine Fehlermeldung: der Nutzer suchte seine Daten im falschen Brain.
//
// Und es wird hoechstens EINMAL je Prozess versucht. Die Gegenstelle laesst
// 5 Versuche je IP und Stunde zu; ein Werkzeugaufruf im Sekundentakt haette
// die Grenze in einer Minute gerissen und danach fuer eine Stunde jeden
// echten Nutzer hinter derselben Adresse mitgesperrt.

import { saveApiKey } from './credentials.js';

/** Was die Gegenstelle zurueckgibt. Stand 28.08.2026, siehe instant_trial_handler.go. */
export interface SofortTest {
  apiKey: string;
  instanzId: string;
  /** Wann der Dev-Tarif endet. Der Schluessel selbst laeuft nicht ab. */
  tarifEndetAm?: string;
}

/**
 * Die Herkunft steht im User-Agent, und zwar im ERSTEN Feld.
 *
 * Die Gegenstelle nimmt genau das: `model.ClientAusUserAgent` schneidet das
 * erste Feld heraus und legt es als `tenants.signup_client` ab.
 * `IstEigenerClient` erkennt alles mit dem Vorsatz `cachly-` als eigenes
 * Werkzeug. Deshalb steht die Herkunft vorne und nicht in einem Klammerzusatz
 * — dort waere sie unsichtbar.
 *
 * Woher wir wissen, dass wir als Plugin laufen: das Plugin-Manifest setzt
 * CACHLY_QUELLE. Geraten wird nichts.
 */
export function userAgent(version: string, env: Record<string, string | undefined> = process.env): string {
  const quelle = env.CACHLY_QUELLE?.trim();
  const werkzeug = quelle && /^[a-z0-9-]{1,40}$/.test(quelle) ? `cachly-${quelle}` : 'cachly-mcp';
  return `${werkzeug}/${version}`;
}

/** Die Adresse der Gegenstelle. */
export function sofortTestUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/auth/instant-trial`;
}

/**
 * Liest die Antwort. Gibt null zurueck, wenn ein Pflichtfeld fehlt — eine
 * halbe Antwort ist kein Zugang, und ein leerer String als Kennung waere
 * genau die stille Null, gegen die dieser ganze Weg gebaut ist.
 */
export function leseAntwort(roh: unknown): SofortTest | null {
  if (!roh || typeof roh !== 'object') return null;
  const o = roh as Record<string, unknown>;
  const apiKey = typeof o.api_key === 'string' ? o.api_key : '';
  const instanzId = typeof o.instance_id === 'string' ? o.instance_id : '';
  if (!apiKey || !instanzId) return null;
  return {
    apiKey,
    instanzId,
    tarifEndetAm: typeof o.trial_ends_at === 'string' ? o.trial_ends_at : undefined,
  };
}

let versuchtInDiesemProzess = false;

/** Nur fuer Tests: setzt die Einmal-Sperre zurueck. */
export function _sperreZuruecksetzen(): void {
  versuchtInDiesemProzess = false;
}

export interface SofortTestOptionen {
  apiUrl: string;
  version: string;
  /** Zum Einspeisen in Tests. */
  holen?: typeof fetch;
  /** Zum Einspeisen in Tests. */
  speichern?: (key: string) => void;
  env?: Record<string, string | undefined>;
}

/**
 * Holt einen Sofort-Test. Gibt null zurueck, wenn es nicht geklappt hat —
 * der Aufrufer arbeitet dann ohne Brain weiter und sagt das auch.
 *
 * Wirft NIE. Ein Server, der beim Start an der Einrichtung stirbt, ist
 * schlimmer als einer ohne Brain.
 */
export async function holeSofortTest(opt: SofortTestOptionen): Promise<SofortTest | null> {
  if (versuchtInDiesemProzess) return null;
  versuchtInDiesemProzess = true;

  const holen = opt.holen ?? fetch;
  const speichern = opt.speichern ?? saveApiKey;
  try {
    const antwort = await holen(sofortTestUrl(opt.apiUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': userAgent(opt.version, opt.env ?? process.env),
      },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    if (!antwort.ok) return null;
    const test = leseAntwort(await antwort.json());
    if (!test) return null;
    speichern(test.apiKey);
    return test;
  } catch {
    // Offline, Zeitueberschreitung, Grenze erreicht. Der Aufrufer meldet es.
    return null;
  }
}
