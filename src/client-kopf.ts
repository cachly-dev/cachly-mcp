/**
 * Kopf `X-Cachly-Client: mcp/<version>` an jedem Aufruf der API (Stufe 2,
 * Bauplan A5 und A6, 27.11.2026).
 *
 * Die API schreibt den Kopf ins Zugriffsprotokoll. Damit laesst sich vor dem
 * Scharfschalten einer Org ZAEHLEN, welches Mitglied noch eine alte Fassung
 * ohne Benutzernamen faehrt: die bekaeme nach dem Scharfschalten WRONGPASS.
 *
 * Gezaehlt wird "fehlt der Kopf". Darum muss JEDER Aufruf dieser Fassung ihn
 * tragen, nicht nur apiFetch: sonst saehe ein Aufruf der Zaehler, des
 * Gesundheitschecks oder der Einbettung aus wie eine alte Fassung. Deshalb
 * EINE Stelle um fetch, wie bei installiereApiKoepfe (remote-zugang.ts), und
 * nur fuer Adressen der API. Andere Ziele (npm, Anbieter von Einbettungen)
 * bekommen nichts.
 */

export const CLIENT_KOPF = 'X-Cachly-Client';

/** Der Wert des Kopfes. */
export function clientKopfWert(version: string): string {
  return `mcp/${version}`;
}

/** Geht diese Adresse an die API? Vergleich nach Herkunft (Schema, Rechner, Port). */
export function istApiAdresse(url: string, apiUrl: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(apiUrl);
    return a.origin === b.origin && a.pathname.startsWith(b.pathname.replace(/\/+$/, '') || '/');
  } catch {
    return false;
  }
}

/**
 * Haengt den Kopf an jeden fetch an die API. `apiUrl` ist eine Funktion, weil
 * `--api-url` die Adresse nach dem Start noch aendern kann. Ein Kopf, den der
 * Aufrufer selbst setzt, bleibt. Gibt eine Funktion zurueck, die den alten
 * fetch wieder einsetzt (fuer Tests).
 */
export function installiereClientKopf(
  apiUrl: () => string,
  wert: string,
  ziel: { fetch: typeof fetch } = globalThis,
): () => void {
  const roh = ziel.fetch;
  const gebunden = roh.bind(ziel);
  ziel.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!istApiAdresse(url, apiUrl())) return gebunden(input, init);
    const koepfe = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!koepfe.has(CLIENT_KOPF)) koepfe.set(CLIENT_KOPF, wert);
    return gebunden(input, { ...init, headers: koepfe });
  }) as typeof fetch;
  return () => { ziel.fetch = roh; };
}
