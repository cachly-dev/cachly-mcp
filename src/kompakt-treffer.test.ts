/**
 * Wie viele Treffer der Kompakt-Modus zeigt.
 *
 * Die Zahl war bis zum 03.09.2026 fest auf fuenf. Gemessen an den
 * Mitschriften beider Bench-Laeufe sieht eine Antwort im teuren Stand 15,7
 * verschiedene Sitzungen, im schlanken nur 6,3 — und in vier von zehn Zellen
 * kommt gar kein Stueck der richtigen Sitzung an. Deshalb ist die Zahl jetzt
 * verstellbar, mit Grenzen.
 *
 * Diese Tests halten die Grenzen fest. Eine Stellschraube ohne Grenzen ist
 * eine Zeitbombe: `CACHLY_RECALL_COMPACT_HITS=500` wuerde den Kompakt-Modus
 * in sein Gegenteil verkehren, und niemand saehe es, bis die Rechnung kommt.
 */

import { describe, expect, it } from "vitest";

/**
 * Dieselbe Rechnung wie in handlers/brain.ts. Sie steht hier nach, weil sie
 * in brain.ts inline im Kompakt-Block sitzt; wer eine davon aendert, aendert
 * beide. (Die Auslagerung lohnt bei drei Zeilen nicht, das Risiko einer
 * zweiten Wahrheit schon — daher dieser Hinweis.)
 */
function kompaktTreffer(wert: string | undefined): number {
  const roh = Number.parseInt(wert ?? "", 10);
  return Number.isFinite(roh) ? Math.min(20, Math.max(1, roh)) : 5;
}

describe("Trefferzahl im Kompakt-Modus", () => {
  it("zeigt ohne Einstellung fuenf", () => {
    expect(kompaktTreffer(undefined)).toBe(5);
    expect(kompaktTreffer("")).toBe(5);
  });

  it("nimmt eine gesetzte Zahl an", () => {
    expect(kompaktTreffer("10")).toBe(10);
    expect(kompaktTreffer("8")).toBe(8);
  });

  it("deckelt bei zwanzig", () => {
    // Zwanzig Treffer sind 8.000 Zeichen Vorschau, rund 2.000 Token je Abruf.
    // Darueber ist es kein Kompakt-Modus mehr, sondern ein Vollabzug.
    expect(kompaktTreffer("500")).toBe(20);
    expect(kompaktTreffer("21")).toBe(20);
  });

  it("laesst nie unter eins fallen", () => {
    // Null Treffer sind kein sparsamer Abruf, sondern ein stummer.
    expect(kompaktTreffer("0")).toBe(1);
    expect(kompaktTreffer("-3")).toBe(1);
  });

  it("faellt bei Unsinn auf fuenf zurueck statt auf null", () => {
    // Ein Tippfehler in der Umgebung darf das Gedaechtnis nicht abschalten.
    expect(kompaktTreffer("viele")).toBe(5);
    expect(kompaktTreffer("acht")).toBe(5);
  });

  it("liest die fuehrende Zahl aus '10 Treffer'", () => {
    // parseInt ist hier absichtlich nachsichtig: wer eine Einheit mitschreibt,
    // bekommt die Zahl, nicht die Voreinstellung.
    expect(kompaktTreffer("10 Treffer")).toBe(10);
  });

  it("rechnet die Kosten nach: jeder Treffer kostet rund 100 Token", () => {
    // 400 Zeichen Vorschau, vier Zeichen je Token. Die Zahl steht in der
    // Vorregistrierung von Arm D und traegt dort die Untergrenze.
    const zeichenJeTreffer = 400;
    const tokenJeTreffer = zeichenJeTreffer / 4;

    expect(kompaktTreffer("5") * tokenJeTreffer).toBe(500);
    expect(kompaktTreffer("10") * tokenJeTreffer).toBe(1000);
    // Der Aufschlag von fuenf auf zehn Treffer:
    expect((kompaktTreffer("10") - kompaktTreffer("5")) * tokenJeTreffer).toBe(500);
  });
});
