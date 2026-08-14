import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

/**
 * GROW-042 — Jede Adresse, die die Befehlszeile ruft, muss es im Server geben.
 *
 * WARUM ES DAS GIBT
 * Am 13.08.2026 fand ein Worker, dass `cachly digest` die Adresse
 * /api/v1/instances/{id}/brain/stats ruft. Der Server kennt aber
 * /instances/:id/brain-stats — Schraegstrich statt Bindestrich. Ein Zeichen.
 *
 * Beim Nachmessen am 14.08. war es nicht ein Befehl, sondern FUENF:
 * digest, demo, share, init und setup riefen dieselbe tote Adresse. Darunter
 * die beiden Einrichtungsbefehle, die jeder neue Nutzer als erstes ausfuehrt.
 *
 * Die Fehlerklasse ist bekannt: dieselbe Zeichenkette an zwei Orten gepflegt,
 * ohne Pruefung dazwischen. Und sie blieb lange unbemerkt, weil ein 404 hier
 * nicht laut wird — er endet in einem catch und der Befehl zeigt eben nichts.
 *
 * WIE ER PRUEFT
 * Er liest ALLE /api/v1/instances/...-Adressen aus index.ts und verlangt fuer
 * jede eine passende Route in api/cmd/server/routes.go. Keine Liste von Hand:
 * eine neue Adresse ist automatisch mitgeprueft.
 */

const root = (p: string) => new URL(`../../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(root(p), 'utf8');

// Wie in DOC-001: im npm-Spiegel liegt der Go-Server nicht im Checkout.
// Ohne ihn ist die Pruefung nicht moeglich — dann wird sie uebersprungen,
// nicht stillschweigend gruen gemeldet.
const routesPfad = 'api/cmd/server/routes.go';
const imMonorepo = existsSync(root(routesPfad));

/** `/api/v1/instances/${x}/brain-stats` → `/instances/:id/brain-stats` */
function alsServerPfad(clientPfad: string): string {
  return clientPfad
    .replace(/^\/api\/v1/, '')
    .replace(/\$\{[^}]*\}/g, ':id');
}

describe.skipIf(!imMonorepo)('GROW-042: jede CLI-Adresse existiert im Server', () => {
  const cli = imMonorepo ? read('sdk/mcp/src/index.ts') : '';
  const routes = imMonorepo ? read(routesPfad) : '';

  // Nur die Instanz-Adressen: die /v1/cache/:token/...-Familie loest der
  // Server ueber ResolveInstance auf und ist hier nicht gemeint.
  const gefunden = [...new Set(
    [...cli.matchAll(/\/api\/v1\/instances\/\$\{[^}]+\}\/[a-z0-9/_-]+/g)].map((m) => m[0]),
  )];

  it('findet ueberhaupt Adressen — sonst prueft dieser Test nichts', () => {
    // Ohne diese Zusicherung wuerde der Test gruen melden, wenn sich die
    // Schreibweise in index.ts aendert und der Ausdruck nichts mehr trifft.
    expect(gefunden.length).toBeGreaterThan(3);
  });

  it.each(gefunden)('%s existiert in routes.go', (clientPfad) => {
    const serverPfad = alsServerPfad(clientPfad);
    // Der letzte Abschnitt ist der aussagekraeftige: /instances/:id/brain-stats
    // → "brain-stats". Genau dort sass der Fehler (brain/stats vs brain-stats).
    expect(routes).toContain(`"/instances/:id/${serverPfad.split('/').slice(3).join('/')}"`);
  });

  it('die tote Adresse brain/stats kommt nicht zurueck', () => {
    expect(cli).not.toContain('/brain/stats');
  });

  /**
   * Zweite Haelfte derselben Fehlerklasse: die Adresse kann stimmen und die
   * FELDER trotzdem nicht existieren.
   *
   * Nach der Reparatur der Adresse zeigte `digest` weiter ueberall Nullen. Der
   * Grund: /instances/:id/brain-stats liefert Such-Telemetrie, keine
   * Lektionen — lesson_count, total_recall_count und top_lessons wurden in dem
   * Handler NIE gefuellt. Die Zahlen stehen in /instances/:id/memory. Und
   * quality_score gibt es in KEINEM der beiden; das Feld heisst iq_boost_pct.
   *
   * Ein fehlendes Feld in JSON ist `undefined`, und `?? 0` macht daraus eine
   * Null. Deshalb sah es nach einem leeren Brain aus statt nach einem Fehler.
   */
  const MEMORY_STRUCT = 'MemoryStatsResponse';

  it('jedes Feld, das die CLI aus /memory liest, gibt es auch in der Antwort', () => {
    const api = read('api/internal/handler/instance_handler.go');
    const structAnfang = api.indexOf(`type ${MEMORY_STRUCT} struct {`);
    expect(structAnfang).toBeGreaterThan(-1);
    const structText = api.slice(structAnfang, api.indexOf('\n}', structAnfang));
    const vorhandene = new Set(
      [...structText.matchAll(/json:"([a-z0-9_]+)/g)].map((m) => m[1]),
    );

    // Alle Typ-Angaben direkt hinter einem /memory-Aufruf einsammeln.
    // Verschachtelte Blöcke (z. B. top_lessons: Array<{ topic; … }>) fliegen
    // vorher raus — deren Felder gehoeren zu einem anderen Typ, nicht zur
    // Antwort selbst. Ohne das meldete der Test faelschlich topic/severity/tags.
    const ohneVerschachtelung = (s: string) => {
      let vorher: string;
      let jetzt = s;
      do {
        vorher = jetzt;
        jetzt = jetzt.replace(/\{[^{}]*\}/g, '');
      } while (jetzt !== vorher);
      return jetzt;
    };
    const gelesen = new Set<string>();
    for (const m of cli.matchAll(/\/api\/v1\/instances\/\$\{[^}]+\}\/memory[\s\S]{0,900}?as \{([\s\S]*?)\};/g)) {
      for (const f of ohneVerschachtelung(m[1]).matchAll(/([a-z0-9_]+)\?:/g)) gelesen.add(f[1]);
    }

    expect(gelesen.size).toBeGreaterThan(3);
    const fehlend = [...gelesen].filter((f) => !vorhandene.has(f));
    expect(fehlend, `Felder ohne Entsprechung in ${MEMORY_STRUCT}`).toEqual([]);
  });

  it('sagt Nein: quality_score gibt es in der Antwort nicht', () => {
    // Gegenprobe zum Test darueber. Waere quality_score doch ein Feld der
    // Antwort, haette die Pruefung oben nie anschlagen koennen.
    const api = read('api/internal/handler/instance_handler.go');
    const structAnfang = api.indexOf(`type ${MEMORY_STRUCT} struct {`);
    const structText = api.slice(structAnfang, api.indexOf('\n}', structAnfang));
    expect(structText).not.toContain('json:"quality_score"');
    expect(structText).toContain('json:"iq_boost_pct"');
  });

  it('sagt Nein: eine erfundene Adresse wuerde nicht in routes.go stehen', () => {
    // Gegenprobe. Ohne sie waere nicht belegt, dass toContain hier ueberhaupt
    // etwas ausschliessen KANN — am 13.08. meldeten zwei Gegenproben
    // faelschlich gruen, weil sie gar nicht greifen konnten.
    expect(routes).not.toContain('"/instances/:id/brain/stats"');
    expect(routes).not.toContain('"/instances/:id/gibt-es-nicht"');
  });
});
