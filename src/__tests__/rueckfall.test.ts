import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artVon, rueckfallHinweis } from '../rueckfall.js';
import { RUECKFALL } from '../rueckfall-daten.js';

/*
 * Kreuzprobe Produkt = Messung: die erwarteten Arten hat der Python-Erkenner
 * der Messung (was_kam_danach.py klasse(), Muster aus rueckfall-daten.ts)
 * am 08.11.2026 berechnet. Weicht artVon davon ab, beschreiben die Zahlen im
 * Hinweis nicht mehr den Erkenner, der ihn ausloest.
 */
const KREUZPROBE: Array<[string, string]> = [
  ['Timezone offset wrong after DST switch, timestamps shifted by one hour', 'zeit-datum'],
  ['Zeitzone falsch: Zeitstempel nach Sommerzeit eine Stunde daneben', 'zeit-datum'],
  ['Upload of large PDF fails with 413, attachment rejected', 'dateien-upload'],
  ['Hochladen großer Dateien bricht ab, Dateigröße über Grenze', 'dateien-upload'],
  ['docker image layer cache invalidated on every build', 'zwischenspeicher'],
  ['bump dependency to fix deprecated API, breaking change in v3', 'abhaengigkeiten'],
  ['login token expired, session lost', 'anmeldung-rechte'],
  ['calendar date picker crashes on leap day', 'zeit-datum'],
  ['', 'sonstiges'],
  // Gleichstand 1:1 (zeit-datum gegen datenbank) -> frueher genannte Art
  ['Ausrollen hängt am Zeitstempel-Vergleich in der Datenbank-Migration', 'zeit-datum'],
  // Gleichstand 1:1 (dateien-upload gegen netzwerk) -> frueher genannte Art
  ['Download bricht ab bei Netzwerk-Timeout', 'dateien-upload'],
  ['UTF-8 encoding of file names in upload breaks emoji', 'zeichen-kodierung'],
];

describe('artVon — gleiche Regel wie die Messung', () => {
  it.each(KREUZPROBE)('%s -> %s', (text, art) => {
    expect(artVon(text)).toBe(art);
  });

  it('liest nur die ersten 600 Zeichen', () => {
    expect(artVon(`${'x '.repeat(300)} timezone timestamp`)).toBe('sonstiges');
  });

  it('jedes Muster ist ein gueltiger regulaerer Ausdruck', () => {
    for (const [art, quelle] of Object.entries(RUECKFALL.arten)) {
      expect(() => new RegExp(quelle, 'gi'), art).not.toThrow();
    }
  });
});

describe('rueckfallHinweis', () => {
  const zeit = {
    outcome: 'success',
    topic: 'kalender:zeitzone-bei-sommerzeit',
    what_worked: 'Zeitstempel in UTC speichern, beim Anzeigen in die Zeitzone des Nutzers umrechnen.',
    file_paths: ['src/kalender/zeit.ts'],
  };

  it('nennt die gezaehlten Zahlen, den Rat, die Datei und ein Beispiel', () => {
    const z = RUECKFALL.zahlen['zeit-datum'];
    const text = rueckfallHinweis(zeit);
    expect(text).toContain(`${z.wiederkehr} of ${z.folgen}`);
    expect(text).toContain(`${z.faktor.toFixed(1)}×`);
    expect(text).toContain(`within ${z.fenster_tage} days`);
    expect(text).toContain(z.rat);
    expect(text).toContain('`src/kalender/zeit.ts`');
    expect(text).toContain(`https://github.com/${z.beispiel.repo}/issues/${z.beispiel.issue}`);
  });

  it('ohne Dateien kein "Same files here"', () => {
    expect(rueckfallHinweis({ ...zeit, file_paths: [] })).not.toContain('Same files here');
  });

  it('schweigt bei Fehlschlag und Teilerfolg', () => {
    expect(rueckfallHinweis({ ...zeit, outcome: 'failure' })).toBe('');
    expect(rueckfallHinweis({ ...zeit, outcome: 'partial' })).toBe('');
  });

  it('schweigt bei Arten ohne Beleg (Upload fiel auf dem dritten Datensatz durch, Anmeldung nie belegt)', () => {
    expect(rueckfallHinweis({ outcome: 'success', topic: 'upload:grenze', what_worked: 'Upload of large PDF fails with 413, attachment rejected' })).toBe('');
    expect(rueckfallHinweis({ outcome: 'success', topic: 'upload:grenze', what_worked: 'Hochladen grosser Dateien: Dateigröße vorher pruefen' })).toBe('');
    expect(rueckfallHinweis({ outcome: 'success', topic: 'auth:login', what_worked: 'login token refreshed' })).toBe('');
  });

  it('nennt Abhaengigkeiten mit Zahlen und Beispiel', () => {
    const z = RUECKFALL.zahlen.abhaengigkeiten;
    const text = rueckfallHinweis({ outcome: 'success', topic: 'deps:bump', what_worked: 'bump dependency, deprecated API removed' });
    expect(text).toContain('Relapse watch (dependency)');
    expect(text).toContain(`${z.wiederkehr} of ${z.folgen}`);
    expect(text).toContain(`https://github.com/${z.beispiel.repo}/issues/${z.beispiel.folge_issue}`);
  });

  it('erkennt Abhaengigkeiten auch auf Deutsch', () => {
    expect(rueckfallHinweis({ outcome: 'success', topic: 'abhaengigkeit:v3', what_worked: 'Abhängigkeit auf v3 gehoben, alte Schnittstelle nicht mehr kompatibel' })).toContain('dependency');
  });
});

describe('Waechter: Muster und Zahlen gehoeren zusammen', () => {
  it('die Muster sind die, mit denen die Zahlen gemessen wurden', () => {
    // Die Pruefsumme schreibt die Messung (rueckfall_zahlen.py) mit den Zahlen.
    // Wer ein Muster aendert, misst neu und traegt beides ein — sonst
    // beschreiben die Zahlen einen anderen Erkenner als den ausgelieferten.
    const summe = createHash('sha256').update(JSON.stringify(RUECKFALL.arten)).digest('hex').slice(0, 16);
    expect(summe, 'Muster geaendert ohne neue Messung').toBe(RUECKFALL._arten_pruefsumme);
  });
});

describe('Waechter: die README nennt dieselben Zahlen wie die Daten', () => {
  it('Zeit/Datum-Beispiel in der README = rueckfall-daten.ts', () => {
    // Die npm-Startseite zitiert den Hinweis. Neue Messung -> neue Zahlen in
    // rueckfall-daten.ts -> dieser Test zeigt, dass die README nachzieht.
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const z = RUECKFALL.zahlen['zeit-datum'];
    expect(readme).toContain(`${z.projekte} open-source projects`);
    expect(readme).toContain(`${z.wiederkehr} of ${z.folgen} time/date fixes (${Math.round((100 * z.wiederkehr) / z.folgen)} %)`);
    expect(readme).toContain(`within ${z.fenster_tage} days`);
    expect(readme).toContain(`${z.faktor.toFixed(1)}× as often`);
  });
});

describe('Waechter: nur belegte Arten bekommen einen Hinweis', () => {
  it('jede Art mit Zahlen ist gemessen, hat einen Rat und Faktor >= 2', () => {
    const geprueft = new Set<string>(RUECKFALL.pruef_arten);
    for (const [art, z] of Object.entries(RUECKFALL.zahlen)) {
      expect(geprueft.has(art), `${art} steht nicht in pruef_arten`).toBe(true);
      expect(Object.keys(RUECKFALL.arten)).toContain(art);
      expect(z.faktor, art).toBeGreaterThanOrEqual(2);
      expect(z.folgen, art).toBeGreaterThanOrEqual(300);
      expect(z.wiederkehr / z.folgen, art).toBeGreaterThan(z.zufall_quote);
      expect(z.rat.length, art).toBeGreaterThan(20);
      // Beispiel = zwei verschiedene Issues, mindestens einen Tag auseinander
      expect(z.beispiel.folge_issue, art).not.toBe(z.beispiel.issue);
      expect(z.beispiel.tage, art).toBeGreaterThanOrEqual(1);
    }
  });
});
