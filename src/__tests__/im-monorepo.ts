/**
 * EINE Antwort auf die Frage "laufen wir im Monorepo?" (Karte nbks8m1ty4d7).
 *
 * ── Das Pardon und sein Grund ─────────────────────────────────────────────
 *
 * Vier Probendateien pruefen Dinge, die es nur im Monorepo gibt: die
 * Faehigkeitsliste, die Kalibrier-Vektoren, die CLI-Adressen des Servers, die
 * erzeugte Wahrheit in den Wurzeldokumenten. Wird `sdk/mcp` allein nach npm
 * veroeffentlicht, fehlen diese Dateien — die Proben dort ROT werden zu
 * lassen, waere falsch: sie pruefen etwas, das in diesem Paket gar nicht
 * mitgeliefert wird.
 *
 * Das ist ein legitimes Pardon. Es hat aber einen GRUND, und der lautet
 * "wir laufen nicht im Monorepo" — nicht "diese eine Datei fehlt gerade".
 *
 * ── Warum das vorher gefaehrlich war ──────────────────────────────────────
 *
 * Jede der vier Dateien entschied es SELBST, an einem anderen Merkmal:
 *
 *     DOC-001               existsSync(root('CACHLY_CAPABILITIES.json'))
 *     GROW-042              existsSync(root(routesPfad))
 *     ambient-gate-vectors  existsSync(VECTORS_PATH)
 *     confidence-vectors    IS_MONOREPO aus einem dritten Ort
 *
 * Vier Merkmale, vier Gelegenheiten zum Irrtum. Zieht eine dieser Dateien um
 * oder wird sie umbenannt, haelt sich die zugehoerige Probe fuer "ausserhalb
 * des Monorepos" und ueberspringt sich selbst — der Lauf bleibt GRUEN, und
 * niemand erfaehrt, dass ein ganzer Pruefblock verschwunden ist.
 *
 * Das ist die Fehlerklasse dieser Karte: eine Unterdrueckung ueberlebt ihren
 * Grund. Sie war fuer den npm-Versand gedacht und feuert seitdem auch bei
 * jedem Umzug im eigenen Haus.
 *
 * ── Wie das Pardon jetzt verfaellt ────────────────────────────────────────
 *
 * Es gibt EINE Entscheidung, und sie haengt an dem Merkmal, das WIRKLICH den
 * Unterschied macht: dem Wurzel-Paket `cachly`. Ein veroeffentlichtes
 * `@cachly-dev/mcp-server` hat es nicht, dieses Repo immer.
 *
 * Und `pardon-verfaellt.test.ts` haelt fest, dass hier — im Monorepo — genau
 * NULL Proben uebersprungen werden. Bricht die Erkennung, wird der Lauf rot,
 * statt still zu schrumpfen.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** sdk/mcp/src/__tests__ → drei Ebenen hoch ist sdk/mcp, vier ist die Wurzel. */
const HIER = dirname(fileURLToPath(import.meta.url));
export const WURZEL = join(HIER, '..', '..', '..', '..');

/**
 * Das Merkmal: das Wurzel-Paket heisst `cachly`.
 *
 * Bewusst der NAME und nicht nur die Existenz der Datei — ein
 * veroeffentlichtes Paket hat auch eine package.json, nur eine andere.
 */
function erkenneMonorepo(): boolean {
  const p = join(WURZEL, 'package.json');
  if (!existsSync(p)) return false;
  try {
    return (JSON.parse(readFileSync(p, 'utf8')) as { name?: string }).name === 'cachly';
  } catch {
    // Unlesbare package.json heisst "nicht das Monorepo" — die vorsichtige
    // Richtung. Sie ist NICHT still: der Waechter unten macht daraus einen
    // roten Lauf, sobald hier gearbeitet wird.
    return false;
  }
}

export const IM_MONOREPO = erkenneMonorepo();

/** Ein Pfad relativ zur Monorepo-Wurzel. */
export const wurzelPfad = (...teile: string[]) => join(WURZEL, ...teile);
