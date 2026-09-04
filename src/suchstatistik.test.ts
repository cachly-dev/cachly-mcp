/**
 * Die Suchstatistik des Dashboards, geschrieben vom MCP-Weg.
 *
 * Der Anlass ist gemessen (03.09.2026): ein Konto mit 3.467 Abrufen sah im
 * Dashboard "0 Suchen, 0 ms Latenz, keine haeufigen Anfragen". Es gab zwei
 * Suchwege und nur einen Zaehler — geschrieben wurde die Statistik allein im
 * gRPC-Pfad (Go), waehrend der Hauptweg unserer Nutzer durch den MCP-Server
 * laeuft.
 *
 * Diese Tests halten fest, was der MCP-Weg schreiben muss, damit die Zahlen
 * dieselben bleiben wie im Go-Pfad. Schluesselnamen sind hier Vertrag: wer
 * einen aendert, muss `api/internal/brainsearch/bm25.go` mitaendern.
 */

import { describe, expect, it } from "vitest";
import { merkeSuchlauf, SUCHSTATISTIK_SCHLUESSEL as SCHLUESSEL, TAGESZAHL_TTL_SEKUNDEN, LATENZ_FENSTER } from "./suchstatistik.js";


/** Eine Attrappe, die nur mitschreibt, was befohlen wurde. */
function attrappe() {
  const befehle: Array<[string, ...unknown[]]> = [];
  const rohr = {
    incr: (k: string) => (befehle.push(["incr", k]), rohr),
    expire: (k: string, s: number) => (befehle.push(["expire", k, s]), rohr),
    lpush: (k: string, v: string) => (befehle.push(["lpush", k, v]), rohr),
    ltrim: (k: string, a: number, b: number) => (befehle.push(["ltrim", k, a, b]), rohr),
    zincrby: (k: string, n: number, m: string) => (befehle.push(["zincrby", k, n, m]), rohr),
    exec: async () => [],
  };
  return { befehle, redis: { pipeline: () => rohr } };
}

describe("Suchstatistik vom MCP-Weg", () => {
  it("erhoeht Gesamtzahl und Tageszahl", async () => {
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "wie war der Port", 42);

    const tag = new Date().toISOString().slice(0, 10);
    expect(befehle).toContainEqual(["incr", SCHLUESSEL.gesamt]);
    expect(befehle).toContainEqual(["incr", SCHLUESSEL.jeTag(tag)]);
  });

  it("laesst die Tageszahl nach sieben Tagen verfallen", async () => {
    // Sonst waechst der Bestand des Kunden mit einem Schluessel je Tag,
    // fuer immer. Der Go-Pfad setzt dieselbe Frist.
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "frage", 1);

    const ablauf = befehle.find((b) => b[0] === "expire");
    expect(ablauf?.[2]).toBe(TAGESZAHL_TTL_SEKUNDEN);
  });

  it("haelt die Latenzliste bei 200 Eintraegen", async () => {
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "frage", 137);

    expect(befehle).toContainEqual(["lpush", SCHLUESSEL.latenz, "137"]);
    expect(befehle).toContainEqual(["ltrim", SCHLUESSEL.latenz, 0, LATENZ_FENSTER - 1]);
  });

  it("rundet die Dauer und laesst sie nie negativ werden", async () => {
    // Eine Uhr, die zurueckspringt, darf keine negative Latenz eintragen --
    // der Mittelwert im Dashboard waere danach dauerhaft falsch.
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "frage", -5.7);

    expect(befehle).toContainEqual(["lpush", SCHLUESSEL.latenz, "0"]);
  });

  it("kuerzt lange Fragen auf 80 Zeichen mit Auslassung", async () => {
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "x".repeat(120), 1);

    const eintrag = befehle.find((b) => b[0] === "zincrby");
    expect(String(eintrag?.[3])).toHaveLength(81);
    expect(String(eintrag?.[3]).endsWith("…")).toBe(true);
  });

  it("nimmt sehr lange Fragen gar nicht in die Bestenliste", async () => {
    // Ueber 200 Zeichen ist keine Frage mehr, sondern ein eingefuegter Text.
    // Er wuerde die Liste unlesbar machen und den Bestand aufblaehen.
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "y".repeat(250), 1);

    expect(befehle.some((b) => b[0] === "zincrby")).toBe(false);
  });

  it("nimmt leere Fragen nicht in die Bestenliste", async () => {
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "   ", 1);

    expect(befehle.some((b) => b[0] === "zincrby")).toBe(false);
    expect(befehle).toContainEqual(["incr", SCHLUESSEL.gesamt]);
  });

  it("faltet Zeilenumbrueche und Mehrfach-Leerzeichen zu einem", async () => {
    const { befehle, redis } = attrappe();
    await merkeSuchlauf(redis, "wie  war\n\tder   Port", 1);

    const eintrag = befehle.find((b) => b[0] === "zincrby");
    expect(eintrag?.[3]).toBe("wie war der Port");
  });
});
