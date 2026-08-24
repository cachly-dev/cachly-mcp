import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ══ Die Versionsnummer steht ueberall gleich — geprueft IM Pull Request ════
 *
 * ── Die Luecke ────────────────────────────────────────────────────────────
 *
 * Es gab schon einen Waechter dafuer. Er steht in
 * `.github/workflows/mcp-publish.yml` und laeuft NACH dem Merge.
 *
 * Damit ist ein Pull Request, in dem `package.json` auf 0.10.131 steht und
 * `glama.json` noch auf 0.10.130, vollstaendig GRUEN. Der Fehler faellt erst
 * auf, wenn niemand mehr hinschaut — und dann faerbt er keinen PR mehr rot,
 * sondern laesst nur die Veroeffentlichung aus. Auf npm liegt danach weiter
 * der alte Stand.
 *
 * Genau das passierte am 20.08.2026 mit 0.10.125: Merge gruen, zwei
 * Veroeffentlichungen hintereinander umgefallen, gemerkt hat es tagelang
 * niemand.
 *
 * ── Warum das trotzdem nicht die eigentliche Antwort ist ──────────────────
 *
 * Die eigentliche Antwort ist, die Nummer NIE von Hand zu heben:
 *
 *     cd sdk/mcp && npm version patch
 *
 * `npm` hebt package.json und ruft danach den Haken `version`, der
 * `nummer-nachziehen.mjs` und `tool-spec-snapshots:write` faehrt. Ein
 * Handgriff, alle Stellen.
 *
 * Am 24.08.2026 wurde die Nummer TROTZ dieses Handgriffs wieder an sechs
 * Stellen von Hand gehoben — weil er nirgends stand ausser im Kommentarkopf
 * jenes Skripts. Diese Probe ist das Netz darunter, nicht der Ersatz dafuer.
 * Deshalb nennt ihre Fehlermeldung den Befehl.
 *
 * ── Was diese Probe zusaetzlich prueft ────────────────────────────────────
 *
 * Die erzeugte OpenAPI-Spezifikation. Der Waechter in mcp-publish.yml kennt
 * vier Stellen; diese hier ist die fuenfte und faellt ihm durch. Sie ist am
 * 24.08.2026 aufgefallen, weil eine Veroeffentlichung an ihr haengenblieb.
 */

const MCP = resolve(__dirname, "..", "..");
const WURZEL = resolve(MCP, "..", "..");

/** package.json ist die Quelle. Alle anderen ziehen nach. */
const SOLL: string = JSON.parse(
  readFileSync(join(MCP, "package.json"), "utf8"),
).version;

type Stelle = { name: string; lies: () => string | undefined };

const STELLEN: Stelle[] = [
  {
    name: "server.json",
    lies: () => JSON.parse(readFileSync(join(MCP, "server.json"), "utf8")).version,
  },
  {
    name: "server.json packages[0]",
    lies: () =>
      JSON.parse(readFileSync(join(MCP, "server.json"), "utf8")).packages?.[0]?.version,
  },
  {
    name: "glama.json",
    lies: () => JSON.parse(readFileSync(join(MCP, "glama.json"), "utf8")).version,
  },
  {
    name: "smithery.yaml",
    lies: () =>
      readFileSync(join(MCP, "smithery.yaml"), "utf8")
        .split(/\r?\n/)
        .find((z) => /^version:/.test(z))
        ?.replace(/^version:\s*/, "")
        .replace(/["']/g, "")
        .trim(),
  },
  {
    name: "docs/generated/tool-specs/cachly.openapi.json",
    lies: () =>
      JSON.parse(
        readFileSync(
          join(WURZEL, "docs", "generated", "tool-specs", "cachly.openapi.json"),
          "utf8",
        ),
      ).info?.version,
  },
];

const HINWEIS =
  "\n\nNummer NIE von Hand heben. Ein Handgriff zieht alle Stellen nach:" +
  "\n    cd sdk/mcp && npm version patch" +
  "\n\n(npm hebt package.json und faehrt danach den Haken `version`:" +
  " scripts/nummer-nachziehen.mjs + tool-spec-snapshots:write.)";

describe("Eine Nummer an allen Stellen", () => {
  it("package.json traegt ueberhaupt eine Nummer", () => {
    /*
     * Ohne diese Zeile waeren die Proben darunter gruen, wenn SOLL undefined
     * ist — dann verglichen sie undefined mit undefined. Eine gruene Null ist
     * hier die gefaehrlichste Antwort.
     */
    expect(SOLL, "package.json hat kein version-Feld").toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(STELLEN.map((s) => s.name))("%s steht auf derselben Nummer", (name) => {
    const stelle = STELLEN.find((s) => s.name === name)!;
    let ist: string | undefined;
    try {
      ist = stelle.lies();
    } catch (err) {
      throw new Error(
        `${name} ist nicht lesbar: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    expect(
      ist,
      `package.json steht auf ${SOLL}, ${name} auf ${ist ?? "—"}.${HINWEIS}`,
    ).toBe(SOLL);
  });

  it("KONTROLLE: es werden wirklich fuenf Stellen geprueft", () => {
    /*
     * Kommt eine Stelle dazu (ein weiteres Verzeichnis-Manifest), faellt hier
     * auf, dass sie hier UND in scripts/nummer-nachziehen.mjs eingetragen
     * gehoert. Ohne diese Zahl waechst die Zahl der Stellen und die Zahl der
     * bewachten Stellen auseinander — still.
     */
    expect(STELLEN.length).toBe(5);
    for (const s of STELLEN) {
      expect(s.lies(), `${s.name} liefert nichts — der Lesepfad ist kaputt`).toBeTruthy();
    }
  });

  it("KONTROLLE: ein Auseinanderlaufen wuerde auffallen", () => {
    // Sonst bewacht die Probe nur, dass sie selbst laeuft.
    expect("0.10.130").not.toBe("0.10.131");
    expect(STELLEN.map((s) => s.lies())).not.toContain(undefined);
  });
});
