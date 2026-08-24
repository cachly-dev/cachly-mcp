import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ══ Das veroeffentlichte Paket verschenkt nichts ═══════════════════════════
 *
 * ── Der Anlass, gemessen am 24.08.2026 ────────────────────────────────────
 *
 * Das Repo `cachly-dev/cachly` ist privat. Das npm-Paket
 * `@cachly-dev/mcp-server` ist oeffentlich. `npm pack --dry-run` zeigte
 * 211 Dateien, darunter:
 *
 *     dist/src/rangfolge.js       9,2 kB   lesbares JavaScript
 *     dist/src/rangfolge.js.map   4,2 kB   Quellkarte
 *     dist/src/rangfolge.d.ts     8,2 kB   vollstaendige Typen
 *
 * Die Gewichte der Rangfolge, die Spreizung, der ganze Aufbau der Sortierung
 * lagen lesbar auf npm — ohne dass wir irgendetwas dafuer bekommen haetten.
 *
 * Es gibt drei Moeglichkeiten, und nur eine davon kostet ohne Gegenwert:
 *
 *   bewusst offen     Beitraege, Vertrauen, Verbreitung
 *   bewusst zu        kein Gegenwert, aber auch nichts verschenkt
 *   versehentlich     kein Gegenwert UND alles verschenkt
 *
 * Entschieden wurde: zu. Nach dem Umbau sind es 79 Dateien und 255 kB,
 * `rangfolge.js` misst 1,7 kB und ist verkleinert.
 *
 * ── Was diese Probe haelt ─────────────────────────────────────────────────
 *
 * Zwei Dinge, die beide einzeln reichen wuerden, um das Paket wieder zu
 * oeffnen: die Ausschlussliste in `files` und der Verkleinerungsschritt im
 * Bau. Faellt eines von beiden weg, faellt diese Probe.
 *
 * Nicht geprueft wird der Inhalt von `dist` — den gibt es beim Testen nicht
 * zwingend. Geprueft wird, dass die REGELN stehen.
 */

const WURZEL = resolve(__dirname, '..', '..');
const PAKET = JSON.parse(readFileSync(resolve(WURZEL, 'package.json'), 'utf8')) as {
  files?: string[];
  scripts?: Record<string, string>;
};

describe('Die Ausschlussliste laesst keine Quellkarten durch', () => {
  it('es gibt ueberhaupt eine Liste', () => {
    // Ohne `files` liefert npm ALLES aus, was nicht in .npmignore steht —
    // inklusive src/. Das waere die weiteste moegliche Oeffnung.
    expect(PAKET.files, 'keine files-Liste — npm liefert dann alles aus').toBeDefined();
    expect(PAKET.files!.length).toBeGreaterThan(0);
  });

  it('kein Eintrag zieht Quellkarten oder Typdateien mit', () => {
    /*
     * Bis zum 24.08.2026 stand hier `dist/src/**./*` — ein Stern, der ALLES
     * einsammelt: .js, .js.map, .d.ts. Die Karte fuehrt zurueck zum Aufbau,
     * die Typdatei zeichnet die ganze Schnittstelle nach.
     *
     * Geprueft wird deshalb: jeder Eintrag unter dist endet auf `.js` oder
     * nennt eine einzelne Datei. Ein offenes Sternchen ist verboten.
     */
    for (const eintrag of PAKET.files ?? []) {
      if (!eintrag.startsWith('dist/')) continue;
      const offen = eintrag.endsWith('*') && !eintrag.endsWith('.js');
      expect(
        offen,
        `"${eintrag}" sammelt auch .map und .d.ts ein — auf *.js einschraenken`,
      ).toBe(false);
    }
  });

  it('GEGENPROBE: die alte Fassung faellt durch', () => {
    // Ohne diese Zeile koennte die Pruefung oben gruen sein, weil sie nichts
    // findet — etwa wenn `dist/` nie vorkaeme.
    const alt = ['dist/index.*', 'dist/src/**/*', 'dist/packages/**/*'];
    const schuldige = alt.filter((e) => e.startsWith('dist/') && e.endsWith('*') && !e.endsWith('.js'));
    expect(schuldige.length).toBeGreaterThan(0);
  });

  it('und es wird ueberhaupt etwas aus dist ausgeliefert', () => {
    // Sonst waere die Regel auch erfuellt, indem man das Paket leer macht —
    // und niemand koennte den Server mehr starten.
    expect((PAKET.files ?? []).some((e) => e.startsWith('dist/'))).toBe(true);
  });
});

describe('Der Bau schliesst das Paket', () => {
  it('der Verkleinerungsschritt steht im build', () => {
    // Die Ausschlussliste allein genuegt nicht: sie haelt Karten und Typen
    // draussen, macht den Quelltext aber nicht unlesbar.
    expect(PAKET.scripts?.build, 'kein build-Skript').toBeDefined();
    expect(
      PAKET.scripts!.build,
      'paket-schliessen.mjs fehlt im build — das Paket waere wieder lesbar',
    ).toContain('paket-schliessen.mjs');
  });

  it('er laeuft NACH tsc und VOR dem Bauabdruck', () => {
    // Vor tsc gaebe es nichts zu verkleinern; nach dem Bauabdruck wuerde der
    // Abdruck eine Fassung beschreiben, die es nicht mehr gibt.
    const b = PAKET.scripts!.build;
    expect(b.indexOf('tsc')).toBeLessThan(b.indexOf('paket-schliessen.mjs'));
    if (b.includes('bauabdruck')) {
      expect(b.indexOf('paket-schliessen.mjs')).toBeLessThan(b.indexOf('bauabdruck'));
    }
  });

  it('das Skript gibt es wirklich', () => {
    const s = readFileSync(resolve(WURZEL, 'scripts/paket-schliessen.mjs'), 'utf8');
    expect(s).toContain('minify: true');
    // Und es bricht ab, wenn doch eine Karte uebrig bleibt.
    expect(s).toContain('process.exit(1)');
  });
});
