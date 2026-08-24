import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SINN_TOPF,
  EINGANG_SCHWELLE,
  EINGANG_SORTIER_GEWICHT,
} from '../rangfolge-stellschrauben.js';

/**
 * ══ Die Stellschrauben stehen an EINEM Ort ═════════════════════════════════
 *
 * ── Der Anlass, mit Zahlen ────────────────────────────────────────────────
 *
 * Am 20.08.2026 sortierte der Messstand mit `bewerteTopf`, der ausgelieferte
 * Pfad mit `mischeRangfolgen` (RRF). Die Fehlertext-Eingaenge brachten im
 * Messstand **+6 Punkte** Findequote@3 (52 auf 58), im Produkt **+1** (50 auf
 * 51). Die Zahl im Ergebnisdokument war richtig — sie beschrieb nur eine
 * Suchmaschine, die es nicht gab.
 *
 * Danach wurden beide Seiten angeglichen, aber die ZAHLEN blieben doppelt:
 *
 *     handlers/brain.ts          bench/echter-korpus.ts
 *     SINN_TOPF = 75             const POOL = 75
 *     EINGANG_SCHWELLE = 0.5     const EINGANG_SCHWELLE = 0.5
 *     EINGANG_SORTIER_GEWICHT    gewicht: 0.2
 *
 * Der Messstand baut die Sortierung nach, statt sie aufzurufen. Das war
 * bekannt und wurde mit Disziplin abgesichert — die Kommentare dort warnen an
 * drei Stellen ausdruecklich davor. Zwei Quellen, die von Hand gleichgehalten
 * werden, gehen irgendwann auseinander; genau das war ja schon passiert.
 *
 * ── Was diese Probe haelt ────────────────────────────────────────────────
 *
 * Dass keine der drei Zahlen ausserhalb von `rangfolge-stellschrauben.ts` als
 * eigener Wert steht. Geprueft wird der Quelltext, weil ein Nachbau sich zur
 * Laufzeit nicht von einem Aufruf unterscheidet.
 */

const SRC = resolve(__dirname, '..');

/** Alle .ts-Dateien unter src, ohne Proben und ohne die Quelle selbst. */
function quelldateien(): string[] {
  const treffer: string[] = [];
  const gehe = (ordner: string) => {
    for (const eintrag of readdirSync(ordner, { withFileTypes: true })) {
      const pfad = resolve(ordner, eintrag.name);
      if (eintrag.isDirectory()) { gehe(pfad); continue; }
      if (!eintrag.name.endsWith('.ts')) continue;
      if (eintrag.name.endsWith('.test.ts')) continue;
      if (eintrag.name === 'rangfolge-stellschrauben.ts') continue;
      treffer.push(pfad);
    }
  };
  gehe(SRC);
  return treffer;
}

/** Kommentare ausblenden, Zeilennummern behalten. */
function ohneKommentare(quelle: string): string {
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (t, vor: string) =>
      vor + ' '.repeat(t.length - vor.length));
}

const DATEIEN = quelldateien().map((p) => ({
  pfad: p.slice(SRC.length + 1).replace(/\\/g, '/'),
  code: ohneKommentare(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')),
}));

describe('Die Stellschrauben gibt es wirklich', () => {
  it('sie tragen die gemessenen Werte', () => {
    // Ohne das koennte die Datei leer sein und jede Pruefung unten waere
    // gruen, ohne etwas abzusichern.
    expect(SINN_TOPF).toBe(75);
    expect(EINGANG_SCHWELLE).toBe(0.5);
    expect(EINGANG_SORTIER_GEWICHT).toBe(0.7);
  });

  it('es gibt ueberhaupt Dateien zu pruefen', () => {
    expect(DATEIEN.length).toBeGreaterThan(20);
  });
});

describe('Niemand schreibt die Zahlen ab', () => {
  /**
   * Gesucht wird eine ZUWEISUNG des Wertes an einen Namen, der wie eine
   * Stellschraube heisst — nicht die Zahl an sich. `0.5` kommt im Quelltext
   * an vielen harmlosen Stellen vor.
   */
  const MUSTER: Array<[string, RegExp]> = [
    ['SINN_TOPF', /\b(SINN_TOPF|POOL|pool)\s*[=:]\s*75\b/],
    /*
     * ── Der Fall, den das Muster darueber NICHT gefunden hat ──────────────
     *
     * Am 24.08.2026 stand in elf Messwerkzeugen `flag('pool') ?? '25'` — eine
     * VORGABE, kein abgeschriebener Wert. Der Ausdruck oben sucht nach der
     * Zahl 75 und sah davon nichts.
     *
     * Die Wirkung war groesser als jede Abschrift: jede Messung ohne
     * ausdrueckliches --pool lief gegen eine Suchmaschine mit einem DRITTEL
     * der Kandidaten. Die Vorauswahl-Decke las sich als 87 statt 95 Prozent,
     * und die Gewichte wurden auf einem Topf angepasst, den es im Produkt
     * nicht gibt.
     *
     * Deshalb ein zweites Muster: eine Zahl als Vorgabe fuer `pool` ist
     * verboten, egal welche. Der Wert kommt aus SINN_TOPF.
     */
    ['pool-Vorgabe', /flag\('pool'\)\s*\?\?\s*['"`]\d+['"`]/],
    ['EINGANG_SCHWELLE', /\bEINGANG_SCHWELLE\s*[=:]\s*0\.5/],
    ['EINGANG_SORTIER_GEWICHT', /\bEINGANG_SORTIER_GEWICHT\s*[=:]\s*0\.7/],
  ];

  it.each(MUSTER)('%s steht nirgends sonst als eigener Wert', (name, muster) => {
    const schuldige = DATEIEN.filter((d) => muster.test(d.code)).map((d) => d.pfad);
    expect(
      schuldige,
      `${name} ist abgeschrieben in: ${schuldige.join(', ')} — `
      + 'der Wert gehoert nach rangfolge-stellschrauben.ts, sonst misst der '
      + 'Messstand irgendwann eine andere Suchmaschine als die ausgelieferte',
    ).toEqual([]);
  });

  it('GEGENPROBE: das Muster wuerde eine Abschrift finden', () => {
    // Ohne diese Zeile koennte der Ausdruck nichts treffen und jede Pruefung
    // oben waere gruen, ohne etwas gelesen zu haben.
    const erfunden = 'const EINGANG_SCHWELLE = 0.5;\n  const POOL = 75;';
    expect(MUSTER[0][1].test(erfunden)).toBe(true); // SINN_TOPF
    // Der Fall, den das erste Muster NICHT sieht: eine VORGABE statt eines
    // abgeschriebenen Wertes. Genau der ist am 24.08.2026 elf Mal
    // durchgerutscht und liess jede Messung mit einem Drittel des Topfes
    // laufen.
    expect(MUSTER[1][1].test("Number(flag('pool') ?? '25')")).toBe(true);
    expect(MUSTER[1][1].test("Number(flag('pool') ?? String(SINN_TOPF))")).toBe(false);
    expect(MUSTER[2][1].test(erfunden)).toBe(true); // EINGANG_SCHWELLE
    expect(MUSTER[3][1].test(erfunden)).toBe(false);
    expect(MUSTER[3][1].test('const EINGANG_SORTIER_GEWICHT = 0.7;')).toBe(true);
  });

  it('GEGENPROBE: Kommentare zaehlen nicht als Abschrift', () => {
    // Die Stellschrauben-Datei und die Erklaerungen in brain.ts nennen die
    // Zahlen im Fliesstext. Eine Probe, die das meldet, waere nach zwei Tagen
    // abgeschaltet — derselbe Fehler ist am 23.08.2026 viermal passiert.
    const mitKommentar = '// EINGANG_SCHWELLE = 0.5 stand hier frueher\nconst x = 1;';
    expect(MUSTER[2][1].test(ohneKommentare(mitKommentar))).toBe(false);
  });
});

describe('Beide Seiten benutzen wirklich dieselbe Quelle', () => {
  const liest = (pfad: string) =>
    DATEIEN.find((d) => d.pfad === pfad)?.code ?? '';

  it('der ausgelieferte Pfad importiert sie', () => {
    expect(liest('handlers/brain.ts')).toContain('rangfolge-stellschrauben.js');
  });

  it('der Messstand importiert sie', () => {
    // Genau hier lief es am 20.08.2026 auseinander.
    expect(liest('bench/echter-korpus.ts')).toContain('rangfolge-stellschrauben.js');
  });
});
