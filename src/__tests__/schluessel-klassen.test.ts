/**
 * Waechter: Jede Familie `cachly:<x>` im Quelltext hat eine Klasse (S/W/B),
 * und die Klasse passt zum ACL-Muster der Mitglieder (Stufe 2, Bauplan A4/A5).
 *
 * Abnahme 2.2: Eine erfundene Familie `cachly:neu:` im Quelltext macht diesen
 * Test rot. Gelesen werden nur Zeichenketten und Vorlagen (TypeScript-Scanner),
 * keine Kommentare: in Kommentaren stehen Lektions-Themen wie
 * `cachly:brain-pflege-loeschte-...`, die nie Schluessel sind.
 *
 * Drei Pruefungen:
 *   1. jede Familie im Quelltext (src/, ohne Tests und dist) steht in
 *      SCHLUESSEL_KLASSEN;
 *   2. jede B-Familie ist fuer Mitglieder schreibbar, jede S- und W-Familie
 *      nicht (sonst stuende in der Tabelle eine zweite Wahrheit);
 *   3. das Muster ist wortgleich mit api/internal/brainzugang/acl.go, sobald
 *      die Datei im Checkout liegt (PR 1).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  SCHLUESSEL_KLASSEN,
  MITGLIED_MUSTER,
  mitgliedDarfSchreiben,
  klasseVon,
  familieVon,
  globAlsRegex,
} from "../schluessel-klassen.js";
import { mitgliedMuster } from "../raeume.js";
import { IM_MONOREPO } from "./im-monorepo.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function quelldateien(ordner: string): string[] {
  const raus: string[] = [];
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name);
    if (statSync(pfad).isDirectory()) {
      if (name === "__tests__" || name === "dist" || name === "node_modules")
        continue;
      raus.push(...quelldateien(pfad));
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      raus.push(pfad);
    }
  }
  return raus;
}

/** Alle Familien `cachly:<x>` in Zeichenketten und Vorlagen eines Quelltexts. */
export function familienIn(quelltext: string): Set<string> {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    quelltext,
  );
  const gefunden = new Set<string>();
  const nimm = (text: string) => {
    // `cachly:` am Ende einer Vorlage ohne Familie ("cachly:${x}") zaehlt nicht.
    // Ein Glob wie `cachly:c[^t]*` nennt nur den Anfang einer Familie und zaehlt nicht.
    for (const m of text.matchAll(/cachly:([A-Za-z0-9_-]+)(?![A-Za-z0-9_[-])/g))
      gefunden.add(m[1]);
  };
  // Welche `}` eine Vorlage fortsetzt und welche einen Block schliesst.
  const stapel: Array<"vorlage" | "klammer"> = [];
  // Ein `/` ist nur nach einem Operator ein regulaerer Ausdruck, sonst Division.
  const vorWert = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.CloseParenToken,
    ts.SyntaxKind.CloseBracketToken,
    ts.SyntaxKind.CloseBraceToken,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.ThisKeyword,
    ts.SyntaxKind.RegularExpressionLiteral,
  ]);
  let vorher: ts.SyntaxKind = ts.SyntaxKind.Unknown;
  let t = scanner.scan();
  while (t !== ts.SyntaxKind.EndOfFileToken) {
    if (
      t === ts.SyntaxKind.StringLiteral ||
      t === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      nimm(scanner.getTokenValue());
    } else if (t === ts.SyntaxKind.TemplateHead) {
      nimm(scanner.getTokenValue());
      stapel.push("vorlage");
    } else if (t === ts.SyntaxKind.OpenBraceToken) {
      stapel.push("klammer");
    } else if (t === ts.SyntaxKind.CloseBraceToken) {
      if (stapel.pop() === "vorlage") {
        t = scanner.reScanTemplateToken(false);
        nimm(scanner.getTokenValue());
        if (t === ts.SyntaxKind.TemplateMiddle) stapel.push("vorlage");
      }
    } else if (
      (t === ts.SyntaxKind.SlashToken ||
        t === ts.SyntaxKind.SlashEqualsToken) &&
      !vorWert.has(vorher)
    ) {
      t = scanner.reScanSlashToken();
    }
    vorher = t;
    t = scanner.scan();
  }
  return gefunden;
}

function familienImQuelltext(): Map<string, string[]> {
  const wo = new Map<string, string[]>();
  for (const datei of quelldateien(SRC)) {
    for (const f of familienIn(readFileSync(datei, "utf8"))) {
      const liste = wo.get(f) ?? [];
      liste.push(relative(SRC, datei).replaceAll("\\", "/"));
      wo.set(f, liste);
    }
  }
  return wo;
}

describe("Schluessel-Klassen: jede Familie im Quelltext hat eine Klasse", () => {
  const wo = familienImQuelltext();

  it("findet ueberhaupt Familien (sonst prueft dieser Test nichts)", () => {
    expect(wo.size).toBeGreaterThan(20);
    for (const f of ["lesson", "team", "ctx", "session", "ckg"])
      expect(wo.has(f), f).toBe(true);
  });

  it("jede Familie steht in SCHLUESSEL_KLASSEN (S/W/B)", () => {
    const ohne = [...wo.entries()]
      .filter(([f]) => !(f in SCHLUESSEL_KLASSEN))
      .map(
        ([f, dateien]) => `cachly:${f}: (${[...new Set(dateien)].join(", ")})`,
      );
    expect(
      ohne,
      "Familie ohne Klasse. In src/schluessel-klassen.ts eintragen; beginnt sie mit " +
        "t, l, c, i, w, g, f, b, m, p oder d, sperrt das Muster sie fuer Mitglieder, bis sie in acl.go steht.",
    ).toEqual([]);
  });

  it("der Scanner sieht eine erfundene Familie (Gegenprobe zu Abnahme 2.2)", () => {
    const probe =
      "const k = `cachly:neu:${id}`; // cachly:kommentar:x\nconst j = 'cachly:auch:x';";
    const f = familienIn(probe);
    expect(f.has("neu")).toBe(true);
    expect(f.has("auch")).toBe(true);
    expect(f.has("kommentar")).toBe(false);
    expect("neu" in SCHLUESSEL_KLASSEN).toBe(false);
  });
});

describe("Schluessel-Klassen passen zum ACL-Muster", () => {
  it("B ist fuer Mitglieder schreibbar, S und W nicht", () => {
    const falsch: string[] = [];
    for (const [f, k] of Object.entries(SCHLUESSEL_KLASSEN)) {
      const darf = mitgliedDarfSchreiben(`cachly:${f}:probe`);
      if (k === "B" && !darf)
        falsch.push(`cachly:${f} ist B, das Muster sperrt sie`);
      if (k !== "B" && darf)
        falsch.push(`cachly:${f} ist ${k}, das Muster erlaubt sie`);
    }
    expect(falsch).toEqual([]);
  });

  it("die Faelle aus abnahme-acl-muster.sh", () => {
    for (const k of [
      "cachly:team:roles:i1",
      "cachly:team:review_mode",
      "cachly:lesson:best:deploy:web",
      "cachly:team:audit:i1",
      "cachly:team:group:i1:chefs",
      "cachly:lesson:vec:deploy:web",
      "cachly:withdrawn:best:deploy:web",
    ]) {
      expect(mitgliedDarfSchreiben(k), k).toBe(false);
    }
    for (const k of [
      "cachly:stats:recalls_total",
      "cachly:sem:code:abc",
      "mykey",
      "cart:1",
      "cachlyx",
    ]) {
      expect(mitgliedDarfSchreiben(k), k).toBe(true);
    }
  });

  it("K ist am alten Ort gesperrt, der Konto-Bereich steht im Muster", () => {
    for (const k of [
      "cachly:ctx:wip:datei",
      "cachly:session:last",
      "cachly:wirkung:x",
      "cachly:letzter-recall:x",
      "cachly:liefer:x",
      "cachly:agents:x",
      "cachly:stats:suchprotokoll:x",
      "cachly:stats:reuse_pairs:x",
    ]) {
      expect(mitgliedDarfSchreiben(k), k).toBe(false);
    }
    const privat = "cachly:zone:p:aaaaaaaaaaaaaaaa:";
    const muster = mitgliedMuster({ privat, gruppen: [] });
    expect(muster).toContain(`~${privat}k:*`);
    expect(globAlsRegex(`${privat}k:*`).test(`${privat}k:session:last`)).toBe(
      true,
    );
    expect(mitgliedDarfSchreiben("cachly:stats:recalls_total:x")).toBe(true);
  });

  it("klasseVon und familieVon", () => {
    expect(familieVon("cachly:letzter-recall:i1")).toBe("letzter-recall");
    expect(klasseVon("cachly:lesson:best:x")).toBe("W");
    expect(klasseVon("cachly:team:roles:x")).toBe("S");
    expect(klasseVon("cachly:ctx:x")).toBe("K");
    expect(klasseVon("cachly:stats:x")).toBe("B");
    expect(klasseVon("fremd:schluessel")).toBe("B");
    expect(klasseVon("cachly:neu:x")).toBeUndefined();
  });

  it("globAlsRegex kennt *, ? und Zeichenklassen", () => {
    expect(globAlsRegex("cachly:[^tl]*").test("cachly:session")).toBe(true);
    expect(globAlsRegex("cachly:[^tl]*").test("cachly:team")).toBe(false);
    expect(globAlsRegex("a?c").test("abc")).toBe(true);
    expect(globAlsRegex("a.c").test("abc")).toBe(false);
  });

  const aclGo = fileURLToPath(
    new URL(
      "../../../../api/internal/raeume/testdata/abnahme-konto-acl.sh",
      import.meta.url,
    ),
  );
  const aclDa = IM_MONOREPO && existsSync(aclGo);
  it.runIf(aclDa)(
    "das Muster ist wortgleich mit abnahme-konto-acl.sh (Lesen fest, Schreiben, Befehle)",
    () => {
      const skript = readFileSync(aclGo, "utf8").split("\r\n").join("\n");
      const feld = (name: string): string[] => {
        const block = skript.split("\n" + name + "=(")[1]?.split(")")[0] ?? "";
        return [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      };
      const regeln = [
        ...feld("MITGLIED_LESEN_FEST"),
        ...feld("MITGLIED_SCHREIBEN"),
        ...feld("MITGLIED_BEFEHLE"),
      ];
      expect(regeln.length).toBeGreaterThan(20);
      expect(regeln).toEqual([...MITGLIED_MUSTER]);
    },
  );
  it.runIf(!aclDa)(
    "abnahme-konto-acl.sh liegt nicht im Checkout (vor PR 1 oder npm-Spiegel): Vergleich spaeter",
    () => {
      console.warn(
        "[schluessel-klassen] api/internal/raeume/testdata/abnahme-konto-acl.sh fehlt; der Wortvergleich laeuft, sobald das Skript im Checkout liegt.",
      );
    },
  );
});
