import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IM_MONOREPO, WURZEL } from './im-monorepo.js';

/**
 * Das verbrauchte Pardon (Karte nbks8m1ty4d7).
 *
 * ── Die Klasse ────────────────────────────────────────────────────────────
 *
 * Aus dem EMRG-Fix von pm25coder (26.08.): eine Ausnahme gilt EINMAL, dann
 * ist sie verbraucht. Die Gegenform ist unsere bekannte Falle — eine STEHENDE
 * Unterdrueckung (Wartungsfenster, "kennen wir schon", "gibt es hier nicht")
 * ueberlebt ihren Grund und frisst den naechsten echten Alarm.
 *
 * ── Der Fund im eigenen Haus ──────────────────────────────────────────────
 *
 * Vier Probendateien ueberspringen sich selbst, wenn `sdk/mcp` allein nach
 * npm veroeffentlicht wird — dort fehlen die Dateien, die sie pruefen. Das
 * Pardon ist richtig. Sein GRUND lautet aber "wir laufen nicht im Monorepo",
 * und geprueft wurde stattdessen "diese eine Datei ist gerade da".
 *
 * Vier Dateien, vier verschiedene Merkmale. Zieht eine davon um, haelt sich
 * ihre Probe fuer veroeffentlicht und ueberspringt sich — der Lauf bleibt
 * GRUEN, und ein ganzer Pruefblock ist lautlos weg.
 *
 * ── Was diese Datei festhaelt ─────────────────────────────────────────────
 *
 * 1. Hier IST das Monorepo. Wer das anders sieht, hat die Erkennung kaputt.
 * 2. Es gibt genau EINE Erkennung, nicht vier.
 * 3. Im Monorepo wird NICHTS uebersprungen — die Zahl ist eine Sperrklinke.
 */

const HIER = dirname(fileURLToPath(import.meta.url));

describe('Das Pardon kennt seinen Grund', () => {
  it('hier ist das Monorepo — wer das anders sieht, hat die Erkennung kaputt', () => {
    /*
     * Die wichtigste Zeile der Datei. Ohne sie ist eine kaputte Erkennung
     * unsichtbar: alle vier Suiten ueberspringen sich, der Lauf bleibt gruen,
     * und niemand erfaehrt, dass zwoelf Pruefungen fehlen.
     */
    expect(IM_MONOREPO, `WURZEL zeigt auf ${WURZEL} — dort steht kein Paket namens "cachly"`).toBe(
      true,
    );
  });

  it('die Erkennung haengt am PAKETNAMEN, nicht an einer einzelnen Datei', () => {
    /*
     * Ein Dateiname ist ein Zufall — er kann umziehen. Der Name des
     * Wurzelpakets ist die Sache selbst.
     */
    const quelle = readFileSync(join(HIER, 'im-monorepo.ts'), 'utf8');
    expect(quelle).toContain("=== 'cachly'");
    expect(quelle).toContain('package.json');
  });
});

/**
 * Kommentare UND Zeichenketten ausleeren, Zeilennummern behalten.
 *
 * Die Zeichenketten muessen mit raus, und das hat diese Datei am eigenen Leib
 * gelernt: ihre eigene Gegenprobe fuehrt Beispiele wie
 * `const inMonorepo = existsSync(...)` als TEXT. Ohne das Ausleeren zeigte
 * der Waechter sich selbst an.
 *
 * Die naheliegende Loesung waere eine Ausnahme fuer diese eine Datei gewesen —
 * und das waere genau das, was diese Karte bekaempft: ein Pardon, das bleibt.
 * Eine Zuweisung in einem Textliteral ist nie Code, also faellt sie generell
 * heraus.
 */
function nurCode(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (t, davor: string) => davor + ' '.repeat(t.length - davor.length))
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (t) =>
      t.replace(/[^\n]/g, ' '),
    );
}

function probenDateien(): string[] {
  const raus: string[] = [];
  const lauf = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        lauf(p);
        continue;
      }
      if (p.endsWith('.test.ts')) raus.push(p);
    }
  };
  lauf(join(HIER, '..'));
  return raus;
}

describe('Kein zweiter Weg, das Monorepo zu erkennen', () => {
  /**
   * Woran eine EIGENE Erkennung zu sehen ist: eine Datei, die selbst eine
   * Monorepo-Variable setzt, statt sie zu holen.
   *
   * Die Regel steht ausgeschrieben neben ihrem Ergebnis — eine Zahl ohne ihre
   * Erkennungsregel ist nicht nachpruefbar (Narbe vom 25.08.2026: gemeldet
   * wurden 14 Faelle, tatsaechlich waren es 7).
   */
  /*
   * Zwei Schritte statt eines Musters mit Lookahead.
   *
   * Die erste Fassung war /…=\s*(?!IM_MONOREPO)/ und lag in BEIDE Richtungen
   * falsch:
   *
   *   - Sie meldete `const inMonorepo = IM_MONOREPO;` faelschlich. Grund:
   *     `\s*` zieht sich zurueck, bis die Lookahead-Stelle auf dem LEERZEICHEN
   *     steht — und dort beginnt der Text nicht mit "IM_MONOREPO".
   *   - Sie uebersah `const IS_MONOREPO = existsSync(...)`, weil `[Mm]onorepo`
   *     die Grossschreibung nicht kennt.
   *
   * Aufgefallen ist beides erst, als die Regel an Beispielen ausgedruckt
   * wurde. Die Gegenprobe war vorher gruen, weil sie den einen Fall
   * `const x = IM_MONOREPO;` gar nicht enthielt — eine Gegenprobe ist nur so
   * gut wie ihre Faelle.
   */
  const ZUWEISUNG = /\b(?:const|let)\s+\w*monorepo\w*\s*=([^\n;]*)/gi;
  const eigeneErkennung = (code: string): boolean => {
    for (const m of code.matchAll(ZUWEISUNG)) {
      // Die rechte Seite entscheidet: holt sie die eine Antwort, ist alles gut.
      if (!/\bIM_MONOREPO\b/.test(m[1])) return true;
    }
    return false;
  };

  it('nur im-monorepo.ts entscheidet die Frage', () => {
    const eigene: string[] = [];
    for (const datei of probenDateien()) {
      const code = nurCode(readFileSync(datei, 'utf8'));
      if (eigeneErkennung(code)) {
        eigene.push(relative(WURZEL, datei).split(sep).join('/'));
      }
    }
    expect(
      eigene,
      'Diese Dateien entscheiden selbst, ob sie im Monorepo laufen. ' +
        'Zieht ihr Merkmal um, ueberspringen sie sich still:\n  ' +
        eigene.join('\n  '),
    ).toEqual([]);
  });

  it('GEGENPROBE: die Erkennungsregel trifft, was sie treffen soll — und sonst nichts', () => {
    /*
     * Ohne diese Faelle waere die Probe darueber gruen, sobald das Muster
     * kaputt ist — und null Funde lesen sich wie "alles in Ordnung".
     *
     * Die letzten drei Zeilen stehen hier, weil die erste Fassung genau an
     * ihnen scheiterte und es niemand sah: sie kamen in der Gegenprobe nicht
     * vor.
     */
    // Eigene Erkennung — muss auffallen:
    expect(eigeneErkennung("const inMonorepo = existsSync(root('X.json'));")).toBe(true);
    expect(eigeneErkennung('const imMonorepo = existsSync(root(pfad));')).toBe(true);
    expect(eigeneErkennung('const monorepo = existsSync(VECTORS_PATH);')).toBe(true);
    // Grossgeschrieben zaehlt genauso — daran ist die erste Fassung vorbei:
    expect(eigeneErkennung('const IS_MONOREPO = existsSync(A) && existsSync(B);')).toBe(true);

    // Der erlaubte Weg — darf NICHT auffallen:
    expect(eigeneErkennung("import { IM_MONOREPO } from './im-monorepo.js';")).toBe(false);
    expect(eigeneErkennung('const daten = IM_MONOREPO ? lies() : null;')).toBe(false);
    expect(eigeneErkennung('const inMonorepo = IM_MONOREPO;')).toBe(false);
    expect(eigeneErkennung('const imMonorepo = IM_MONOREPO;')).toBe(false);
    expect(eigeneErkennung('const monorepo = IM_MONOREPO;')).toBe(false);
  });

  it('die Probe sieht ueberhaupt Dateien — sonst prueft sie nichts', () => {
    expect(probenDateien().length).toBeGreaterThan(50);
  });
});
