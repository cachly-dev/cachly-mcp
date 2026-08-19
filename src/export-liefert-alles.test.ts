/**
 * Der Export muss ALLES liefern — und das hier ist der Beweis, nicht die Zusage.
 *
 * ── Der Vorfall ──────────────────────────────────────────────────────────────
 *
 * Am 19.08.2026 gemessen: `cachly export` lieferte 50 Lektionen von 493, jede
 * auf 120 Zeichen gekuerzt. Der Grund war weder ein Tippfehler noch ein
 * kaputter Endpunkt. Der Befehl las aus /memory — der Dashboard-Zusammen-
 * fassung, die genau das tun SOLL: oberste 50, Text gekuerzt, damit eine
 * Lektionsliste in der IDE schnell laedt.
 *
 * Zwei Wahrheiten, eine Quelle: "was zeige ich im Dashboard" und "was gehoert
 * dem Nutzer" wurden aus demselben Endpunkt bedient. Das ist die Fehlerklasse,
 * die uns in diesem Haus am haeufigsten trifft.
 *
 * ── Warum ein Test und keine Notiz ───────────────────────────────────────────
 *
 * Weil ein unvollstaendiger Export nichts rot faerbt. Er laeuft durch, schreibt
 * eine Datei, meldet Erfolg. Der Nutzer merkt es erst, wenn er die Datei
 * braucht — und dann ist es zu spaet, denn er hat sie geholt, WEIL er gehen
 * wollte. Ein Fehler, der sich erst beim Weggehen zeigt, braucht einen
 * Waechter, der frueher schaut.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLessonsJsonl, buildLessonsMarkdown, vonRohLektion } from './brain-export.js';

const HIER = dirname(fileURLToPath(import.meta.url));
const quelle = (datei: string) => readFileSync(join(HIER, datei), 'utf-8');

/**
 * Kommentare raus, bevor irgendetwas gesucht wird.
 *
 * Am 19.08.2026 sind uns eigene Abnahmetests achtmal an den eigenen
 * Kommentaren gruen geworden: der Test suchte einen Begriff, fand ihn in der
 * Erklaerung darueber und meldete Erfolg. Ein Waechter, der Prosa liest, prueft
 * nichts.
 */
function nurCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Export: der volle Bestand, nicht die Zusammenfassung', () => {
  // ── 1. Die Quelle ──────────────────────────────────────────────────────────

  it('holt die Lektionen von /export, nicht von /memory', () => {
    const code = nurCode(quelle('index.ts'));
    const exportBlock = code.slice(code.indexOf("process.argv[2] === 'export'"));
    const bis = exportBlock.indexOf("process.argv[2] === 'invite'");
    const nurExport = bis > 0 ? exportBlock.slice(0, bis) : exportBlock;

    expect(nurExport).toContain('/export');

    // /memory darf noch vorkommen — aber NUR als Rueckfall fuer alte Server,
    // also hinter einer 404-Pruefung. Steht es davor, ist es wieder die
    // Hauptquelle.
    const memoryStelle = nurExport.indexOf('/memory');
    if (memoryStelle !== -1) {
      const rueckfall = nurExport.indexOf('404');
      expect(rueckfall).toBeGreaterThan(-1);
      expect(rueckfall).toBeLessThan(memoryStelle);
    }
  });

  it('sagt es laut, wenn der Export unvollstaendig ist', () => {
    const code = nurCode(quelle('index.ts'));
    // Der Server meldet complete:false. Diese Meldung muss beim Nutzer ankommen.
    expect(code).toContain('complete === false');
    expect(code).toMatch(/INCOMPLETE/);
  });

  // ── 2. Der Inhalt ──────────────────────────────────────────────────────────

  it('kuerzt keinen Lektionstext', () => {
    const langerText = 'A'.repeat(4000);
    const lektion = vonRohLektion({ topic: 'test:lang', what_worked: langerText });
    expect(lektion).not.toBeNull();
    expect(lektion!.whatWorked).toHaveLength(4000);

    const jsonl = buildLessonsJsonl([lektion!]);
    expect(JSON.parse(jsonl.trim()).what_worked).toHaveLength(4000);

    const md = buildLessonsMarkdown([lektion!]);
    expect(md).toContain(langerText);
  });

  it('verliert kein Feld, an das beim Schreiben dieses Tests niemand gedacht hat', () => {
    // Das ist der eigentliche Punkt. Ein Export, der Felder aufzaehlt,
    // exportiert genau die Felder, die jemand aufgezaehlt hat — und verliert
    // still jedes neue. Deshalb reicht der Export den gespeicherten Datensatz
    // roh durch.
    const gespeichert = {
      topic: 'test:vollstaendig',
      outcome: 'success',
      what_worked: 'die kurze Fassung',
      what_failed: 'der Fehlversuch',
      file_paths: ['a.ts'],
      commands: ['npm test'],
      tags: ['x'],
      author: 'heinrich',
      audit_trail: [{ at: '2026-08-19', by: 'heinrich' }],
      ein_feld_von_uebermorgen: 'muss trotzdem mitkommen',
    };
    const lektion = vonRohLektion(gespeichert);
    const zeile = JSON.parse(buildLessonsJsonl([lektion!]).trim());

    for (const feld of Object.keys(gespeichert)) {
      expect(zeile, `Feld "${feld}" fehlt im Export`).toHaveProperty(feld);
    }
    expect(zeile.ein_feld_von_uebermorgen).toBe('muss trotzdem mitkommen');
    expect(zeile.audit_trail).toEqual(gespeichert.audit_trail);
  });

  it('nimmt what_failed und file_paths mit — /memory lieferte sie nie', () => {
    // Diese Felder konnte brain-export.ts von Anfang an rendern. Sie fehlten
    // trotzdem in jedem Export, weil die QUELLE sie nicht mitgab. Der Beleg,
    // dass das Format nie das Problem war.
    const lektion = vonRohLektion({
      topic: 'ci:runner',
      what_worked: 'Runner-Dienst neu gestartet',
      what_failed: 'gh run cancel hat nicht gereicht',
      file_paths: ['.github/workflows/deploy.yml'],
    });
    const md = buildLessonsMarkdown([lektion!]);
    expect(md).toContain('gh run cancel hat nicht gereicht');
    expect(md).toContain('.github/workflows/deploy.yml');
  });

  // ── 3. Die Fehlerklasse ────────────────────────────────────────────────────

  it('haelt Zusammenfassung und Export auseinander', () => {
    // Die Regel hinter dem Vorfall, als Test: der Export-Zweig darf keine
    // Zahlen tragen, die nach Deckel aussehen. Wer hier wieder einen einbaut,
    // faellt auf.
    const code = nurCode(quelle('index.ts'));
    const start = code.indexOf("process.argv[2] === 'export'");
    const ende = code.indexOf("process.argv[2] === 'invite'", start);
    const nurExport = code.slice(start, ende > 0 ? ende : undefined);

    expect(nurExport).not.toMatch(/\.slice\(0,\s*\d+\)/);
    expect(nurExport).not.toMatch(/top_lessons\s*\?\?\s*\[\]\s*\)\s*\.map[\s\S]{0,80}$/);
    // truncate/substring auf dem Lektionstext waere derselbe Fehler in klein.
    expect(nurExport).not.toMatch(/truncate\s*\(/);
    expect(nurExport).not.toMatch(/what_worked[^\n]*substring/);
  });

  it('der Server-Endpunkt kuerzt nicht', () => {
    // Gegenprobe auf der anderen Seite der Leitung. Ohne sie koennte der
    // Client sauber sein und der Server trotzdem 120 Zeichen liefern.
    const goDatei = join(HIER, '..', '..', '..', 'api', 'internal', 'handler', 'export_handler.go');
    let go: string;
    try {
      go = readFileSync(goDatei, 'utf-8');
    } catch {
      // Das SDK wird auch ohne das API-Verzeichnis gebaut (npm-Paket). Dann
      // kann dieser Test nichts pruefen — und sagt das, statt gruen zu sein.
      expect.fail(
        `export_handler.go nicht gefunden (${goDatei}). Wenn das SDK bewusst ohne api/ ` +
        `gebaut wird, gehoert dieser Test in die API-Testsuite verschoben — nicht uebersprungen.`,
      );
      return;
    }
    const goCode = go.replace(/\/\/.*$/gm, '');
    expect(goCode).toContain('func (h *InstanceHandler) Export');
    expect(goCode).not.toMatch(/truncate\s*\(/);
    // json.RawMessage ist der Beweis fuer "durchgereicht statt neu getippt".
    expect(goCode).toContain('json.RawMessage');
  });
});
