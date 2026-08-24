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

/**
 * ══ Nachtrag vom 23.08.2026: der Erfolg zaehlt auch, und der Assistent log ══
 *
 * Karte trichteranm1 ("Der Bruch liegt an der Anmeldung, nicht an der Seite").
 *
 * Zwei Luecken blieben nach der ersten Runde offen:
 *
 * 1. Nur das SCHEITERN wurde gezaehlt. Damit bleiben zwei voellig verschiedene
 *    Ursachen ununterscheidbar — "hat nie einen Browser gesehen" und "hat ihn
 *    gesehen und aufgegeben". Das eine behebt man mit Code, das andere mit
 *    weniger Schritten.
 *
 * 2. Der Einrichtungs-Assistent (`npx ... setup` / `autopilot`) hatte denselben
 *    Fehler wie der Werkzeugpfad — nur schlimmer. Er rief openInBrowser ohne
 *    Rueckruf UND schrieb danach unbedingt:
 *
 *        console.log('   ✓  Browser opened — confirm the code above ...');
 *
 *    Ein Haken davor, also das staerkste Zeichen fuer "erledigt", das die
 *    Ausgabe kennt. Der Mensch wartete auf ein Fenster, das nie kam.
 *    Die Zahlen dazu: setup_auth_started 13, setup_auth_completed 3.
 */
/**
 * Der Quelltext OHNE Kommentare.
 *
 * ── Warum das noetig wurde (23.08.2026, beim Schreiben dieser Proben) ────────
 *
 * Die erste Fassung des Blocks unten war rot, und zwar zu Recht falsch: Die
 * Kommentare oben zitieren die alte Zeile `console.log('   ✓  Browser opened
 * — ...')` und den alten Aufruf `openInBrowser(verifyUri);`, um zu erklaeren,
 * was behoben wurde. Der Waechter fand seine EIGENE Erklaerung im Quelltext
 * wieder und meldete, der Fehler stehe noch da.
 *
 * Das ist dieselbe Fehlerklasse wie am 22.08.: ein Waechter, der Unschuldige
 * greift, wird abgeschaltet — und dann bewacht er nichts mehr.
 *
 * Zeilenbasiert und bewusst grob: ganze Kommentarzeilen fallen weg,
 * angehaengte Kommentare hinter Code bleiben stehen. Fuer diese Datei reicht
 * das, und mehr zu bauen hiesse, einen Parser zu pflegen.
 */
function ohneKommentare(src: string): string {
  return src
    .split('\n')
    .filter((z) => !/^\s*(\/\/|\*|\/\*)/.test(z))
    .join('\n');
}

const CODE = ohneKommentare(QUELLE);

describe('Anmeldung · beide Wege zaehlen und behaupten nichts', () => {
  it('der Erfolg wird ebenfalls gemeldet — sonst fehlt der Nenner', () => {
    expect(QUELLE).toContain("sendFunnelEvent('device_browser_opened'");
  });

  it('beide Ereignisse tragen, an WELCHER Stelle sie entstanden sind', () => {
    // Werkzeugpfad und Einrichtungs-Assistent haben getrennte Trichter (51
    // gegen 15 Starts) und wurden bisher in einen Topf geworfen.
    for (const stelle of ["stelle: 'tool'", "stelle: 'setup'"]) {
      expect(QUELLE, `${stelle} fehlt`).toContain(stelle);
    }
  });

  it('DER BEFUND: der Assistent behauptet nicht mehr, der Browser sei offen', () => {
    // Wenn diese Zeile je wieder auftaucht, ist die Luege zurueck.
    expect(CODE).not.toContain('Browser opened —');
    expect(CODE).not.toMatch(/✓\s+Browser opened/);
  });

  it('stattdessen steht die HANDLUNG da, und zwar VOR dem Browserversuch', () => {
    /*
     * ── Warum diese Probe umgeschrieben wurde (24.08.2026) ────────────────
     *
     * Hier stand ein einziger Satz, woertlich:
     *
     *     expect(QUELLE).toContain('Open the URL above and confirm the code to continue');
     *
     * Einen Tag spaeter wurde derselbe Satz VERBESSERT — die Adresse steht
     * jetzt allein auf ihrer Zeile, weil manche Terminals beim Dreifachklick
     * die Beschriftung mitnehmen. Die Probe fiel um, obwohl die Regel
     * strenger eingehalten war als vorher.
     *
     * Das ist der Waechter, der die SCHREIBWEISE bewacht statt die Regel.
     * Derselbe Fehler ist heute schon einmal aufgefallen (sieben von dreizehn
     * Proben in der Fremdernte). Ein Waechter, den eine Verbesserung umwirft,
     * schuetzt einen Satz, nicht ein Verhalten.
     *
     * Die REGEL ist: die Adresse steht unbedingt da, BEVOR ein Browser
     * versucht wird. Der Browser ist die Bequemlichkeit obendrauf, nicht der
     * Weg. Genau das wird jetzt geprueft.
     */
    const druck = CODE.indexOf('console.log(`${verifyUri}');
    const versuch = CODE.indexOf('openInBrowser(verifyUri');
    expect(druck, 'die Adresse wird nirgends allein gedruckt').toBeGreaterThan(-1);
    expect(versuch, 'Aufrufstelle im Assistenten nicht gefunden').toBeGreaterThan(-1);
    expect(
      druck,
      'die Adresse wird erst NACH dem Browserversuch gedruckt — wer kein Fenster '
        + 'bekommt, sieht sie dann womoeglich gar nicht',
    ).toBeLessThan(versuch);
  });

  it('die Adresse steht ALLEIN auf ihrer Zeile', () => {
    /*
     * Viele Terminals nehmen beim Dreifachklick die ganze Zeile. Stand
     * `   URL:  https://…` da, kopierte der Mensch den Vorspann mit und
     * bekam einen Fehler im Browser, ohne zu wissen warum.
     *
     * Das trifft genau die Leute, bei denen kein Fenster aufging — also die,
     * fuer die dieser Link die EINZIGE Tuer ist.
     */
    expect(
      CODE,
      'die Adresse traegt wieder einen Vorspann in derselben Zeile',
    ).not.toMatch(/console\.log\(`\s*\S+[^`]*\$\{verifyUri\}/);
  });

  it('und eine Anweisung sagt, was damit zu tun ist', () => {
    // Eine nackte Adresse ohne Satz ist eine Zumutung. Geprueft wird die
    // ABSICHT (oeffnen + bestaetigen), nicht der Wortlaut.
    expect(CODE).toMatch(/Open this URL|Open the URL/i);
    expect(CODE).toMatch(/confirm the code/i);
  });

  it('auch der Assistent uebergibt einen Rueckruf', () => {
    const ab = CODE.indexOf('openInBrowser(verifyUri');
    expect(ab, 'Aufrufstelle im Assistenten nicht gefunden').toBeGreaterThan(-1);
    expect(CODE.slice(ab, ab + 400)).toMatch(/openInBrowser\(verifyUri,\s*\(ok, err\)/);
  });

  it('GEGENPROBE: KEIN Aufruf von openInBrowser meldet still Erfolg, wo er etwas behauptet', () => {
    /*
     * Die drei uebrigen Aufrufstellen (Web-Rueckfall, /setup-ai bei 401,
     * /instances) bleiben bewusst ohne Rueckruf: sie drucken die Adresse
     * unmittelbar DAVOR und sind reine Bequemlichkeit. Diese Probe haelt genau
     * das fest — wer dort spaeter einen Erfolgssatz hinschreibt, faellt auf.
     *
     * Gezaehlt statt aufgezaehlt: die Zahl darf sinken, aber nicht steigen,
     * ohne dass jemand hinsieht.
     */
    const ohneRueckruf = [...CODE.matchAll(/^\s*openInBrowser\(([^;]*?)\);/gms)].filter(
      (m) => !m[1].includes('(ok, err)'),
    );
    expect(
      ohneRueckruf.length,
      `Aufrufe ohne Rueckruf: ${ohneRueckruf.map((m) => m[1].slice(0, 40)).join(' · ')}`,
    ).toBeLessThanOrEqual(3);
  });

  it('GEGENPROBE: die beiden Ereignisse schliessen einander aus', () => {
    // Ein Zweig, der beides sendet, macht den Trichter unbrauchbar. Im
    // Erfolgsfall steht ein `return` direkt hinter der Meldung.
    const ab = CODE.indexOf("sendFunnelEvent('device_browser_opened', { stelle: 'tool' });");
    expect(ab, 'Werkzeugpfad sendet den Erfolg nicht').toBeGreaterThan(-1);
    expect(CODE.slice(ab, ab + 120)).toContain('return;');
  });
});
