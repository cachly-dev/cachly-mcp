import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Waechter: das Oeffnen des Browsers darf nicht mehr schweigend scheitern.
 *
 * ─── DER ANLASS, MIT ZAHLEN ─────────────────────────────────────────────────
 *
 * Gemessen am 23.08.2026 in der Produktions-Datenbank:
 *
 *   23.06. bis 14.08.2026   34 Geraete-Anmeldungen BEGONNEN
 *                            0 abgeschlossen
 *
 * Im selben Zeitraum verzeichnete die Seite /device in Plausible NULL Aufrufe,
 * waehrend andere Seitenereignisse derselben Tage normal ankamen. Die Menschen,
 * die einen Code bekamen, haben die Seite also nie gesehen — der Browser ging
 * bei ihnen nicht auf.
 *
 * ─── WARUM ES ZWEI MONATE UNBEMERKT BLIEB ───────────────────────────────────
 *
 * `openInBrowser` rief `execFile` OHNE Rueckruf auf:
 *
 *     execFile('xdg-open', [url]);        // kein Callback
 *
 * Ein ENOENT — kein `xdg-open` in Containern, SSH-Sitzungen und WSL ohne
 * Oberflaeche — kommt asynchron. Das `try/catch` drumherum sah ihn nie. Die
 * Funktion meldete Erfolg, indem sie schwieg, und der Text darunter behauptete
 * "(browser opening...)".
 *
 * Das ist dieselbe Fehlerklasse wie "Stille wird als gruen gebucht": ein
 * Schritt ohne Rueckmeldung gilt als gelungen, bis jemand nachzaehlt.
 *
 * Diese Proben lesen den Quelltext, weil die Alternative — einen fehlenden
 * xdg-open in der Probe herzustellen — die Plattform faelschen wuerde und auf
 * Windows gar nicht ginge. Geprueft wird die REGEL: jeder Startversuch nimmt
 * einen Rueckruf, jeder Fehlschlag erzeugt ein Ereignis und eine Zeile auf
 * stderr.
 */

const QUELLE = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

/** Der Rumpf von openInBrowser, von der Signatur bis zur schliessenden Klammer. */
function rumpfVonOpenInBrowser(): string {
  const ab = QUELLE.indexOf('function openInBrowser(');
  expect(ab, 'openInBrowser nicht gefunden').toBeGreaterThan(-1);
  // Bis zur naechsten Deklaration auf Spaltenebene 0 — reicht fuer diese Datei.
  const bis = QUELLE.indexOf('\n// ──', ab);
  return QUELLE.slice(ab, bis > ab ? bis : ab + 2000);
}

describe('Browser oeffnen · Fehlschlag wird gemeldet', () => {
  const rumpf = rumpfVonOpenInBrowser();

  it('jeder der drei Plattform-Zweige uebergibt einen Rueckruf an execFile', () => {
    // Der Fehler lag genau hier: drei Aufrufe, kein einziger Rueckruf.
    const aufrufe = rumpf.match(/execFile\([^)]*\)/gs) ?? [];
    expect(aufrufe.length, 'es muessen drei Plattform-Zweige sein').toBe(3);
    for (const a of aufrufe) {
      expect(a, `ohne Rueckruf: ${a}`).toContain('nachStart');
    }
  });

  it('openInBrowser nimmt einen Rueckruf entgegen', () => {
    expect(rumpf).toMatch(/function openInBrowser\(\s*url: string,\s*onResult\?/);
  });

  it('ein Fehlschlag erzeugt ein Ereignis mit Grund', () => {
    expect(QUELLE).toContain("sendFunnelEvent('device_browser_failed'");
    expect(QUELLE).toMatch(/device_browser_failed', \{ reason:/);
  });

  it('ein Fehlschlag schreibt die Adresse auf stderr', () => {
    // Der Rueckgabetext eines Werkzeugs landet beim ASSISTENTEN, und ob der
    // ihn zeigt, entscheidet er. stderr landet im Protokoll des Editors.
    const ab = QUELLE.indexOf("sendFunnelEvent('device_browser_failed'");
    const block = QUELLE.slice(ab, ab + 600);
    expect(block).toContain('process.stderr.write');
    expect(block).toContain('flow.verifyUrl');
    expect(block).toContain('flow.userCode');
  });

  it('der Text behauptet nicht mehr, der Browser gehe auf', () => {
    // "(browser opening...)" war zwischen dem 23.06. und 14.08.2026 in 34 von
    // 34 Faellen falsch.
    expect(QUELLE).not.toContain('(browser opening...)');
  });

  it('der Text fordert den Assistenten auf, Link und Code ZU ZEIGEN', () => {
    // Ohne diese Aufforderung entscheidet der Assistent, ob der Mensch die
    // Adresse je sieht — und genau daran haengt der ganze Schritt.
    expect(QUELLE).toMatch(/Show the following link and code to the user verbatim/);
  });

  it('GEGENPROBE: execFile wird wirklich benutzt — die Probe liest nicht ins Leere', () => {
    // Ohne diese Zeile koennte die erste Probe gruen sein, weil das Muster
    // "execFile(" gar nicht mehr vorkommt.
    expect(rumpf).toContain('execFile(');
    expect(rumpf).toContain('xdg-open');
    expect(rumpf).toContain('cmd');
  });

  it('GEGENPROBE: der Rueckruf wird auch wirklich uebergeben, nicht nur definiert', () => {
    // Beweist, dass `nachStart` nicht bloss als tote Funktion herumliegt.
    const ab = QUELLE.indexOf('openInBrowser(flow.verifyUrl');
    expect(ab, 'Aufrufstelle nicht gefunden').toBeGreaterThan(-1);
    const block = QUELLE.slice(ab, ab + 400);
    expect(block).toMatch(/openInBrowser\(flow\.verifyUrl,\s*\(ok, err\)/);
  });

  it('die Werkzeugzahl im Text kommt aus TOOLS, nicht aus einer getippten Zahl', () => {
    // Auf der Landingpage standen 122 und 126 nebeneinander, beide von Hand.
    // Derselbe Fehler stand hier als "122 MCP tools".
    expect(QUELLE).toContain('${TOOLS.length} MCP tools');
    expect(QUELLE).not.toContain('122 MCP tools');
  });
});
