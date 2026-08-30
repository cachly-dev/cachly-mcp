/**
 * Proben fuer die reinen Teile der Widerspruchs-Messung (Karte mco8r4god525).
 *
 * Der Netz- und Redis-Teil laeuft hier NICHT — geprobt wird, was ohne
 * Verbindung falsch werden kann: der Fragebau und die Vier-Wege-Zaehlung.
 */
import { describe, it, expect } from 'vitest';
import { frageAusThema, urteil } from '../widerspruch-in-topk.js';

describe('Frage aus dem Themennamen', () => {
  it('Trenner werden Leerzeichen — mehr nicht', () => {
    expect(frageAusThema('deploy:cache-npm_stellen')).toBe('deploy cache npm stellen');
  });

  it('fuehrt keine Woerter aus dem Lektionstext ein', () => {
    // Die Regel aus korpus-aus-brain.ts: eine Frage mit Antwortwoertern
    // findet jede Rangfolge. Hier kommt ALLES aus dem Themennamen.
    expect(frageAusThema('node4:whisper')).toBe('node4 whisper');
  });
});

describe('Das Vier-Wege-Urteil', () => {
  const paar = { alt: 'deploy:alt', neu: 'deploy:neu' };

  it('beide vorne -> beide', () => {
    expect(urteil(['deploy:neu', 'x', 'deploy:alt'], paar, 3)).toBe('beide');
  });

  it('nur der Sieger vorne -> nur-sieger', () => {
    expect(urteil(['deploy:neu', 'x', 'y'], paar, 3)).toBe('nur-sieger');
  });

  it('nur der Verlierer vorne -> nur-verlierer (der teure Fall)', () => {
    // DAS ist der Fall, um den es der Karte geht: die widerlegte Fassung
    // steht in der Liste, die gueltige nicht.
    expect(urteil(['deploy:alt', 'x', 'y'], paar, 3)).toBe('nur-verlierer');
  });

  it('keiner vorne -> keiner', () => {
    expect(urteil(['a', 'b', 'c'], paar, 3)).toBe('keiner');
  });

  /*
   * Der Fall, der ohne Nachdenken falsch wuerde: k schneidet GENAU zwischen
   * den beiden. Platz 3 zaehlt bei k=3 noch, Platz 4 nicht.
   */
  it('k schneidet exakt: Platz k zaehlt, Platz k+1 nicht', () => {
    expect(urteil(['x', 'y', 'deploy:alt', 'deploy:neu'], paar, 3)).toBe('nur-verlierer');
    expect(urteil(['x', 'y', 'deploy:alt', 'deploy:neu'], paar, 4)).toBe('beide');
  });
});
