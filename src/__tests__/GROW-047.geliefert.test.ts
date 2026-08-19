import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LIEFERNDE_WERKZEUGE,
  hatTreffer,
  inWorten,
  istLieferung,
  lieferBild,
  lieferSchluessel,
  tokenDerAntwort,
  trefferSchluessel,
} from '../geliefert.js';

/**
 * ABNAHME GROW-047 — "Nicht schaetzen, messen."
 *
 * Heinrich am 19.08.2026: "Bei der Schaetzung der Tokenersparnis sollten wir
 * schauen, dass wir nicht nur schaetzen, denn das nervt Leute sehr stark.
 * Vielleicht machen wir eine weitere Metrik rein? Sowas wie Token, die bei den
 * Calls aus dem Brain rausgenommen wurden und nicht aus der AI vom Vendor
 * kamen?"
 *
 * Abnahme:
 *   1. Gezaehlt wird nur, was Gespeichertes herausgibt — nicht jede Antwort.
 *   2. Eine leere Antwort erhoeht die Token-Summe NICHT.
 *   3. Die Trefferquote ist eine Summe zweier Zaehler, keine Schaetzung.
 *   4. Der Text sagt selbst, dass er gemessen ist — und behauptet nicht mehr.
 *
 * Geschrieben VOR der Aenderung.
 */

const roh = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

/**
 * Quelltext OHNE Kommentare.
 *
 * Am 19.08.2026 wurde im Schwesterprojekt gemessen: von 109 Pruefungen, die
 * Quelltext lesen, waren 13 GRUEN, weil die gesuchte Zusage nur in einem
 * Kommentar stand. Zwei davon bewachten seit Wochen Code, den es so nicht
 * mehr gab. Wer eine Zusage im VERHALTEN prueft, darf keine Prosa lesen.
 */
const lies = (rel: string) =>
  roh(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((z) => !z.trimStart().startsWith('//'))
    .join('\n');

describe('GROW-047 · Abnahme 1: nur Abrufe zaehlen', () => {
  it('Abruf-Werkzeuge zaehlen', () => {
    for (const w of ['smart_recall', 'recall_best_solution', 'causal_trace', 'session_start']) {
      expect(istLieferung(w), w).toBe(true);
    }
  });

  it('Schreib- und Verwaltungswerkzeuge zaehlen NICHT', () => {
    for (const w of ['learn_from_attempts', 'create_instance', 'roadmap_add', 'cache_set', 'brain_doctor']) {
      expect(istLieferung(w), w).toBe(false);
    }
  });

  it('die Liste ist eher zu kurz als zu lang — das ist die richtige Richtung', () => {
    // Eine Zahl, mit der geworben wird, darf sich nicht selbst aufblaehen.
    expect(LIEFERNDE_WERKZEUGE.size).toBeLessThan(30);
  });
});

describe('GROW-047 · Abnahme 2: eine leere Antwort erhoeht nichts', () => {
  it('typische Absagen gelten nicht als Treffer', () => {
    for (const t of [
      'No relevant lessons found.',
      'no matching results',
      'Keine passende Lektion gefunden.',
      'Results (0)',
      'nothing cached for this key',
      '',
      '   ',
    ]) {
      expect(hatTreffer(t), JSON.stringify(t)).toBe(false);
    }
  });

  it('eine echte Antwort gilt als Treffer', () => {
    expect(hatTreffer('💡 deploy:api — nohup docker compose up -d --build')).toBe(true);
  });

  /**
   * GEGENPROBE: Die Erkennung darf nicht an der LAENGE haengen. Eine hoefliche
   * Absage ist oft laenger als ein knapper Treffer — genau deshalb wird der
   * Text gelesen und nicht gemessen.
   */
  it('Gegenprobe: die lange Absage verliert gegen den kurzen Treffer', () => {
    const langeAbsage =
      'Ich habe im Gedaechtnis nachgesehen, aber es sind keine passenden Lektionen zu diesem Thema hinterlegt.';
    const kurzerTreffer = 'redis:eviction — maxmemory-policy allkeys-lru';
    expect(langeAbsage.length).toBeGreaterThan(kurzerTreffer.length);
    expect(hatTreffer(langeAbsage)).toBe(false);
    expect(hatTreffer(kurzerTreffer)).toBe(true);
  });
});

describe('GROW-047 · Abnahme 3: die Quote ist eine Summe', () => {
  it('rechnet Treffer durch Abrufe, ohne Annahme', () => {
    const b = lieferBild({ token: 1_840_000, abrufe: 486, treffer: 312 });
    expect(b.token).toBe(1_840_000);
    expect(b.abrufe).toBe(486);
    expect(b.treffer).toBe(312);
    expect(Math.round(b.quote * 100)).toBe(64);
  });

  it('ohne Abruf ist die Quote 0 und nicht NaN', () => {
    expect(lieferBild({}).quote).toBe(0);
  });

  it('mehr Treffer als Abrufe kann es nicht geben', () => {
    // Ein Zaehler, der wegen eines halb durchgelaufenen Schreibvorgangs
    // auseinanderlaeuft, darf keine Quote ueber 100 % erzeugen.
    expect(lieferBild({ abrufe: 10, treffer: 99 }).treffer).toBe(10);
    expect(lieferBild({ abrufe: 10, treffer: 99 }).quote).toBe(1);
  });

  it('Unsinn in den Zaehlern wird zu 0, nicht zu NaN', () => {
    const b = lieferBild({ token: 'kaputt', abrufe: null, treffer: -5 });
    expect(b.token).toBe(0);
    expect(b.abrufe).toBe(0);
    expect(b.treffer).toBe(0);
  });
});

describe('GROW-047 · Abnahme 4: der Text behauptet nicht mehr, als er weiss', () => {
  it('sagt ausdruecklich, dass gemessen und nicht gerechnet wurde', () => {
    const t = inWorten(lieferBild({ token: 1_840_000, abrufe: 486, treffer: 312 }));
    expect(t).toContain('1.84 Mio.');
    expect(t).toContain('486');
    expect(t).toContain('64 %');
    expect(t.toLowerCase()).toContain('gemessen');
    expect(t).toContain('keine Annahme');
  });

  it('behauptet NICHT, das Modell haette diese Token sonst erzeugt', () => {
    const t = inWorten(lieferBild({ token: 500_000, abrufe: 100, treffer: 80 }));
    expect(t).not.toMatch(/gespart|saved|Ersparnis/i);
  });

  it('ohne Abruf steht dort ein ehrliches Nichts', () => {
    expect(inWorten(lieferBild({}))).toContain('noch nichts');
  });

  it('die Datei sagt selbst, was die Zahl NICHT beweist', () => {
    // Diese Pruefung sucht ABSICHTLICH die Erklaerung — also roh().
    const quelle = roh('../geliefert.ts');
    expect(quelle).toContain('KEIN Beweis');
  });
});

describe('GROW-047 · gezaehlt wird an der einen Stelle', () => {
  it('die Schluessel haengen an der Instanz, nicht global', () => {
    expect(lieferSchluessel('abc')).toBe('cachly:stats:delivered_tokens:abc');
    expect(trefferSchluessel('abc')).toBe('cachly:stats:recall_hits:abc');
    expect(lieferSchluessel('a')).not.toBe(lieferSchluessel('b'));
  });

  it('index.ts zaehlt erst, wenn die Antwort feststeht', () => {
    const src = lies('../index.ts');
    expect(src).toContain('zaehleLieferung');
    // Und zwar NACH handleBrainTool — vorher gibt es nichts zu zaehlen.
    const auf = src.indexOf('const brainResult = await handleBrainTool');
    const zaehl = src.indexOf('void zaehleLieferung');
    expect(auf).toBeGreaterThan(-1);
    expect(zaehl).toBeGreaterThan(auf);
  });

  it('brain_metrics zeigt die gemessene Zahl neben der gerechneten', () => {
    const src = lies('../handlers/brain.ts');
    expect(src).toContain('Aus dem Brain geliefert');
    expect(src).toContain('lieferungInWorten');
  });

  it('tokenDerAntwort benutzt dieselbe Schaetzung wie das Einblende-Budget', () => {
    // Zwei Token-Rechnungen im selben Haus waeren eine zweite Wahrheit.
    expect(lies('../geliefert.ts')).toContain("from './ambient-recall.js'");
    expect(tokenDerAntwort('abcd')).toBe(1);
  });
});
