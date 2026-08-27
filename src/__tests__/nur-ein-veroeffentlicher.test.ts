import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ══ Genau EIN Ablauf darf @cachly-dev/mcp-server veroeffentlichen ══════════
 *
 * ── Der Befund vom 24.08.2026 ─────────────────────────────────────────────
 *
 * Es gab ZWEI. Und der zweite lief in einem OEFFENTLICHEN Repository.
 *
 *   .github/workflows/mcp-publish.yml        im Monorepo, mit vier Waechtern
 *   sdk/mcp/.github/workflows/publish.yml    gespiegelt nach cachly-dev/cachly-mcp
 *
 * `mirror-mcp.yml` kopiert `sdk/mcp/` mit `rsync --delete` in das oeffentliche
 * Repository. Ausgenommen sind genau drei Dateien — `publish.yml` ist keine
 * davon. Dort steht `on: push: branches: [main]`, also feuerte JEDE Spiegelung
 * einen zweiten Veroeffentlicher.
 *
 * ── Was der zweite NICHT prueft ───────────────────────────────────────────
 *
 * Der Ablauf im Monorepo hat vier Waechter vor `npm publish`:
 *
 *   Version stimmt in server.json, glama.json und smithery.yaml ueberein
 *   Die beworbene Werkzeugzahl stimmt mit src/tools.ts ueberein
 *   Kein Drift zwischen Faehigkeiten und erzeugter Spezifikation
 *   tsc --noEmit
 *
 * Der gespiegelte hatte keinen einzigen davon: `npm install --ignore-scripts`,
 * `npm test`, `npm run build`, veroeffentlichen.
 *
 * ── Warum es bisher gutging, und warum das kein Trost ist ─────────────────
 *
 * Acht Laeufe in zwei Tagen, alle acht rot — an EINER Probe:
 *
 *     export_handler.go nicht gefunden (/home/runner/work/api/internal/handler/…)
 *
 * Die Datei liegt im Monorepo, nicht im Spiegel. Der einzige Schutz vor einer
 * ungeprueften Veroeffentlichung war also ein Nebeneffekt. Dieselbe Probe sagt
 * in ihrer eigenen Meldung: "Wenn das SDK gebaut wird, gehoert dieser Test in
 * die API-Testsuite verschoben." Wer dieser Anleitung folgt, macht die
 * Veroeffentlichung scharf, ohne es zu merken.
 *
 * Nebenbei: acht rote Laeufe sind in einem oeffentlichen Repository fuer jeden
 * sichtbar, der auf den npm-Link klickt.
 *
 * ── Warum Loeschen und nicht Reparieren ───────────────────────────────────
 *
 * Fehlerklasse "zweite Wahrheit": wo zwei Stellen dasselbe tun, pflegt man
 * eine und vergisst die andere. Der Ausweg ist, eine zu loeschen, nicht beide
 * zu pflegen. Der Ablauf mit den Waechtern bleibt.
 */

const MCP = resolve(__dirname, "..", "..");
const WURZEL = resolve(MCP, "..", "..");

/**
 * Ruft dieser Ablauf `npm publish` auf?
 *
 * Bewusst ohne YAML-Zerleger. `yaml` gehoert nicht zu den Abhaengigkeiten
 * dieses Pakets, und fuer eine Probe eine Abhaengigkeit in ein
 * VEROEFFENTLICHTES Paket zu ziehen, waere der falsche Preis.
 *
 * Kommentarzeilen fallen vorher weg — sonst faellt diese Probe an ihrer
 * eigenen Erklaerung um, die den Befehl woertlich nennt. Das ist im Haus schon
 * fuenf Mal passiert.
 */
export function veroeffentlicht(inhalt: string): boolean {
  return inhalt
    .split(/\r?\n/)
    .filter((z) => !/^\s*#/.test(z))
    .some((z) => /\bnpm\s+publish\b/.test(z));
}

/** Jede Ablaufdatei unterhalb eines Ordners, egal wie tief. */
function alleAblaeufe(ordner: string): string[] {
  const aus: string[] = [];
  if (!existsSync(ordner)) return aus;
  for (const eintrag of readdirSync(ordner, { withFileTypes: true })) {
    const pfad = join(ordner, eintrag.name);
    if (eintrag.isDirectory()) aus.push(...alleAblaeufe(pfad));
    else if (/\.ya?ml$/.test(eintrag.name)) aus.push(pfad);
  }
  return aus;
}

// Umbenannt am 27.08.2026 (Karte nbks8m1ty4d7): die Liste hiess IM_MONOREPO
// und enthaelt keine Ja/Nein-Auskunft ueber das Monorepo, sondern die
// Ablaufdateien der Wurzel, die veroeffentlichen. Der alte Name kollidierte
// mit der echten Monorepo-Erkennung in im-monorepo.ts — ein Waechter kann
// zwei Dinge mit demselben Namen nicht auseinanderhalten, und der Mensch
// auch nicht.
const WURZEL_VEROEFFENTLICHER = alleAblaeufe(join(WURZEL, ".github", "workflows"))
  .filter((p) => veroeffentlicht(readFileSync(p, "utf8")))
  .map((p) => p.slice(WURZEL.length + 1).replace(/\\/g, "/"));

describe("Nur ein Ablauf veroeffentlicht das MCP-Paket", () => {
  it("sdk/mcp traegt selbst keinen Veroeffentlicher", () => {
    /*
     * Der Kern. Alles unter sdk/mcp/.github wird nach cachly-dev/cachly-mcp
     * gespiegelt und laeuft DORT — ausserhalb der Waechter dieses Repositoriums
     * und fuer jeden sichtbar.
     */
    const eigene = alleAblaeufe(join(MCP, ".github"))
      .filter((p) => veroeffentlicht(readFileSync(p, "utf8")))
      .map((p) => p.slice(MCP.length + 1).replace(/\\/g, "/"));

    expect(
      eigene,
      "Diese Datei wird von mirror-mcp.yml nach cachly-dev/cachly-mcp gespiegelt" +
        " und laeuft dort auf jeden Push nach main — ohne die vier Waechter aus" +
        " .github/workflows/mcp-publish.yml (Versionsabgleich, Werkzeugzahl," +
        " Faehigkeits-Drift, tsc). Veroeffentlicht wird aus dem Monorepo.",
    ).toEqual([]);
  });

  it("im Monorepo gibt es genau einen Veroeffentlicher fuer dieses Paket", () => {
    const fuerUns = WURZEL_VEROEFFENTLICHER.filter(
      (p) => /mcp/i.test(p) && /publish/i.test(p),
    );
    expect(fuerUns).toEqual([".github/workflows/mcp-publish.yml"]);
  });

  it("KONTROLLE: die Suche findet ueberhaupt Veroeffentlicher", () => {
    /*
     * Ohne diese Zeile waeren die beiden Proben darueber gruen, weil sie
     * NICHTS finden — etwa wenn der Pfad nicht mehr stimmt. Eine gruene Null
     * ist hier die gefaehrlichste Antwort: sie hiesse "niemand veroeffentlicht
     * mehr", und das waere schlimmer als zwei Veroeffentlicher.
     */
    expect(
      WURZEL_VEROEFFENTLICHER.length,
      "kein einziger Veroeffentlichungs-Schritt gefunden — die Suche ist kaputt",
    ).toBeGreaterThan(0);
  });

  it("KONTROLLE: ein erfundener Veroeffentlicher wird erkannt", () => {
    // Sonst bewacht die Regel oben nur die Schreibweise von heute.
    const mit = ["jobs:", "  x:", "    steps:", "      - run: npm publish --access public"].join("\n");
    const ohne = ["jobs:", "  x:", "    steps:", "      - run: npm test"].join("\n");
    const nurKommentar = ["# hier stand einmal npm publish", "jobs: {}"].join("\n");
    expect(veroeffentlicht(mit)).toBe(true);
    expect(veroeffentlicht(ohne)).toBe(false);
    expect(veroeffentlicht(nurKommentar)).toBe(false);
  });
});
