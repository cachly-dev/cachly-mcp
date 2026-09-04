/**
 * Die Mitschrift der Vorauswahl muss zwei Dinge koennen: schweigen, wenn sie
 * aus ist, und den Abruf nicht toeten, wenn sie nicht schreiben kann.
 *
 * Der zweite Punkt ist der wichtigere. Eine Messung, die den Lauf abbricht,
 * den sie misst, ist teurer als gar keine Messung — und ein Fuenf-Stunden-Lauf
 * stirbt dann an einem vollen Datentraeger.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const aufraeumen: string[] = [];
afterEach(() => {
  for (const p of aufraeumen.splice(0)) rmSync(p, { recursive: true, force: true });
});

/** Das Modul liest den Schalter EINMAL beim Laden — also je Fall frisch laden. */
async function ladeMit(pfad: string | undefined) {
  const vorher = process.env.CACHLY_TOPF_PROTOKOLL;
  if (pfad === undefined) delete process.env.CACHLY_TOPF_PROTOKOLL;
  else process.env.CACHLY_TOPF_PROTOKOLL = pfad;
  vi.resetModules();
  const modul = await import("./topf-protokoll.js");
  if (vorher === undefined) delete process.env.CACHLY_TOPF_PROTOKOLL;
  else process.env.CACHLY_TOPF_PROTOKOLL = vorher;
  return modul as typeof import("./topf-protokoll.js");
}

const NOTIZ = {
  frage: "wie war der Port der Staging-Datenbank",
  themen: ["amb:s1:1", "amb:s1:2", "amb:s2:1"],
  ausWortsuche: 2,
  ausSinnsuche: 3,
  obergrenze: 75,
  gezeigt: ["amb:s1:2", "amb:s2:1"],
};

describe("Topf-Mitschrift", () => {
  it("ist ohne Schalter aus und schreibt nichts", async () => {
    const modul = await ladeMit(undefined);

    expect(modul.topfProtokollAktiv).toBe(false);
    expect(() => modul.schreibeTopfNotiz(NOTIZ)).not.toThrow();
  });

  it("ist bei leerem Schalter aus (nicht 'an mit Pfad Leerstring')", async () => {
    const modul = await ladeMit("   ");

    expect(modul.topfProtokollAktiv).toBe(false);
  });

  it("schreibt je Aufruf eine JSON-Zeile mit Zeitstempel", async () => {
    const ordner = mkdtempSync(join(tmpdir(), "topf-"));
    aufraeumen.push(ordner);
    const datei = join(ordner, "topf.jsonl");
    const modul = await ladeMit(datei);

    modul.schreibeTopfNotiz(NOTIZ);
    modul.schreibeTopfNotiz({ ...NOTIZ, frage: "zweite Frage" });

    // Die Datei traegt die Prozessnummer -- sonst schreiben vier gleichzeitige
    // Zellen ineinander und zerreissen sich die Zeilen.
    const echt = join(ordner, `topf.${process.pid}.jsonl`);
    expect(existsSync(datei)).toBe(false);
    const zeilen = readFileSync(echt, "utf8").trim().split("\n");
    expect(zeilen).toHaveLength(2);

    const erste = JSON.parse(zeilen[0]);
    expect(erste.themen).toEqual(NOTIZ.themen);
    expect(erste.obergrenze).toBe(75);
    expect(erste.gezeigt).toEqual(NOTIZ.gezeigt);
    expect(Date.parse(erste.zeit)).not.toBeNaN();
    expect(JSON.parse(zeilen[1]).frage).toBe("zweite Frage");
  });

  it("stirbt nicht, wenn der Pfad nicht beschreibbar ist", async () => {
    // Ein Verzeichnis, das es nicht gibt: genau der Fall, der einen langen
    // Messlauf sonst in der zweiten Stunde umbringt.
    const modul = await ladeMit(join(tmpdir(), "gibt-es-nicht-4711", "topf.jsonl"));

    expect(modul.topfProtokollAktiv).toBe(true);
    expect(() => modul.schreibeTopfNotiz(NOTIZ)).not.toThrow();
    expect(existsSync(join(tmpdir(), "gibt-es-nicht-4711"))).toBe(false);
  });
});
