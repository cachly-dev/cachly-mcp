import { describe, expect, it } from 'vitest';
import { alsFehlerbild, MIN_WOERTER, reposFuerPaket, uebersetze } from '../starter-brain-bauen.js';

/**
 * Starter-Brains aus der Ernte — die Auslese ist der Teil, der falsch sein
 * kann. Ein zu lasches Tor legt "closes #60408" in Kunden-Brains; ein zu
 * strenges laesst die Pakete leer.
 */

const GUTE_FRAGE = 'Der Login schlaegt fehl, sobald die Sitzung ueber Mitternacht laeuft. '
  + 'Wir sehen im Protokoll einen 401 direkt nach der Tokenerneuerung, aber nur in der Produktionsumgebung.';
const GUTE_LEKTION = 'Die Tokenerneuerung nutzte die lokale Zeitzone statt UTC, dadurch lag das '
  + 'Ablaufdatum eine Stunde in der Vergangenheit. Behoben, indem der Vergleich auf Epochensekunden '
  + 'umgestellt wurde und der Erneuerungspuffer von 30 auf 120 Sekunden stieg. Betroffen waren '
  + 'auth/session.ts und der Cron zur Schluesselrotation.';

describe('uebersetze — das Tor in die Kunden-Brains', () => {
  it('ein gutes Paar wird ein vollstaendiger Eintrag', () => {
    const e = uebersetze(GUTE_FRAGE, { topic: 'demo:pr-1', what_worked: GUTE_LEKTION }, 'sprache:TypeScript');
    if ('verworfen' in e) throw new Error(`faelschlich verworfen: ${e.verworfen}`);
    expect(e.eintrag.what_failed).toContain('401');
    expect(e.eintrag.what_worked).toBe(GUTE_LEKTION);
    expect(e.eintrag.tags).toContain('sprache-typescript');
    expect(e.eintrag.tags).toContain('demo');
    // Maschinell ausgelesen heisst NICHT handgeprueft — 0,7, nicht 0,9.
    expect(e.eintrag.confidence).toBe(0.7);
  });

  it('eine kurze Lektion fliegt schon am ersten Tor (pruefePaar)', () => {
    const e = uebersetze(GUTE_FRAGE, { topic: 'demo:pr-2', what_worked: 'closes #60408 lib/a.ts behoben' }, 's:x');
    expect('verworfen' in e).toBe(true);
  });

  it('eine LANGE Lektion ohne Substanz fliegt am Wortzaehler-Tor', () => {
    /*
     * Der Fall, den pruefePaar NICHT faengt: ueber 80 Zeichen, aber fast nur
     * wiederholte Dateipfade — unter 20 VERSCHIEDENE Inhaltswoerter.
     * Naturworkshop 3: 296 der 586 begrabenen Antworten hatten solche
     * Lektionen ("closes #60408 plus Pfade"). Die duerfen nie in ein
     * Starter-Paket.
     *
     * Die erste Fassung dieser Probe prallte an pruefePaar ab (Lektion unter
     * 80 Zeichen) und behauptete, das Wortzaehler-Tor zu pruefen — eine
     * Probe, die eine andere Frage beantwortet als die gestellte.
     */
    const pfadwurst = `closes #60408 ${'lib/pfad/datei.ts lib/pfad/andere.ts '.repeat(6)}`;
    expect(pfadwurst.length).toBeGreaterThan(80);
    const e = uebersetze(GUTE_FRAGE, { topic: 'demo:pr-2b', what_worked: pfadwurst }, 's:x');
    expect('verworfen' in e && e.verworfen).toContain(String(MIN_WOERTER));
  });

  it('eine Abschrift fliegt — die Antwort darf nicht in der Frage stehen', () => {
    // pruefePaar ist DIESELBE Regel wie beim Messen; hier nur die Probe,
    // dass sie wirklich vorgeschaltet ist.
    const gleich = `${GUTE_FRAGE} und deshalb wurde genau das behoben und dokumentiert und geprueft und verteilt`;
    const e = uebersetze(GUTE_FRAGE, { topic: 'demo:pr-3', what_worked: gleich }, 's:x');
    expect('verworfen' in e).toBe(true);
  });
});

describe('alsFehlerbild — der Issue-Anfang, fuer Menschen geschnitten', () => {
  it('kurze Fragen bleiben ganz, Mehrfach-Leerraum wird geglaettet', () => {
    expect(alsFehlerbild('Ein  Fehler\n\n  im   Deploy')).toBe('Ein Fehler im Deploy');
  });

  it('lange Fragen enden an einer Satzgrenze, nicht mitten im Wort', () => {
    const lang = `${'Der Dienst antwortet nicht mehr. '.repeat(30)}`;
    const f = alsFehlerbild(lang, 200);
    expect(f.length).toBeLessThanOrEqual(201);
    expect(f.endsWith('.')).toBe(true);
  });

  it('KONTROLLE: ohne brauchbare Satzgrenze wird sichtbar gekuerzt', () => {
    const wurst = 'a'.repeat(500);
    const f = alsFehlerbild(wurst, 200);
    expect(f.endsWith('…')).toBe(true);
  });
});

describe('reposFuerPaket — die Schicht aus der Liste', () => {
  const liste = [
    '# Kommentar',
    'flutter/flutter\t178637\t102728\tsprache:Dart',
    'microsoft/vscode\t233856\t170000\tsprache:TypeScript',
    'dart-lang/sdk\t11263\t53539\tsprache:Dart',
  ].join('\n');

  it('liefert genau die Repos der Schicht', () => {
    expect(reposFuerPaket(liste, 'sprache:Dart')).toEqual(['flutter/flutter', 'dart-lang/sdk']);
  });

  it('KONTROLLE: eine unbekannte Schicht liefert leer — und der Aufrufer bricht dann laut ab', () => {
    expect(reposFuerPaket(liste, 'sprache:COBOL')).toEqual([]);
  });
});
