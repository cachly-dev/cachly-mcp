import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artVon, dazuHinweis, rueckfallHinweis } from '../rueckfall.js';
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

describe('dazuHinweis — was zur Reparatur gehoerte (M4)', () => {
  const sicherheit = {
    outcome: 'success',
    topic: 'security:xss-im-suchfeld',
    what_worked: 'Escaped the search term before rendering; XSS payload no longer executes.',
  };

  it('Sicherheits-Fix ohne Abhaengigkeitsdatei: Hinweis mit den gemessenen Zahlen', () => {
    const h = dazuHinweis({ ...sicherheit, file_paths: ['src/search/render.ts'] });
    expect(h).toContain('Belongs to the fix (security)');
    expect(h).toContain('289 open-source projects (1127 security fixes)');
    expect(h).toContain('34 % vs 21 %, 12 % vs 6 %, 59 % vs 25 %');
    expect(h).toContain('add that file to the lesson');
  });

  it('schweigt, wenn eine Abhaengigkeitsdatei schon dabei ist — auch mit Windows-Pfad und Grossbuchstaben', () => {
    for (const datei of ['package-lock.json', 'api/go.sum', 'C:\\repo\\Cargo.toml', 'backend/requirements-dev.txt', 'web/pnpm-lock.yaml']) {
      expect(dazuHinweis({ ...sicherheit, file_paths: ['src/a.ts', datei] }), datei).toBe('');
    }
  });

  it('schweigt ohne genannte Dateien, nach Fehlschlag und bei anderen Arten', () => {
    expect(dazuHinweis({ ...sicherheit })).toBe('');
    expect(dazuHinweis({ ...sicherheit, file_paths: [] })).toBe('');
    expect(dazuHinweis({ ...sicherheit, outcome: 'failure', file_paths: ['src/a.ts'] })).toBe('');
    expect(dazuHinweis({
      outcome: 'success', topic: 'ui:button', what_worked: 'Button layout fixed in dark mode', file_paths: ['src/a.tsx'],
    })).toBe('');
  });

  it('das Muster ist das der Messung: clock.go ist keine Sperrdatei, go.sum schon', () => {
    // Der erste Entwurf der Messung zaehlte clock.go als Sperrdatei ([^/]*lock[^/]*).
    const m = new RegExp(RUECKFALL.dazu.sicherheit.muster);
    expect(m.test('internal/clock.go')).toBe(false);
    expect(m.test('go.sum')).toBe(true);
    expect(m.test('poetry.lock')).toBe(true);
  });

  it('Waechter: die Zahlen erfuellen die vorab festgelegte Regel', () => {
    for (const [art, d] of Object.entries(RUECKFALL.dazu)) {
      expect(Object.keys(RUECKFALL.arten), art).toContain(art);
      expect(d.datensaetze.reduce((s, x) => s + x.fixes, 0), art).toBe(d.fixes);
      // In jedem Datensatz haeufiger als erwartet ...
      for (const s of d.datensaetze) expect(s.anteil, art).toBeGreaterThan(s.erwartet);
      // ... und auf mindestens zwei: >= 1,5-fach, >= 10 Punkte, >= 100 Paare.
      const halten = d.datensaetze.filter((s) => s.anteil >= 1.5 * s.erwartet && s.anteil - s.erwartet >= 0.1 && s.fixes >= 100);
      expect(halten.length, art).toBeGreaterThanOrEqual(2);
    }
  });

  it('Waechter: die README nennt dieselben Zahlen wie die Daten', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const d = RUECKFALL.dazu.sicherheit;
    const groesster = [...d.datensaetze].sort((a, b) => b.fixes - a.fixes)[0];
    expect(readme).toContain(`${d.fixes} security fixes changed a dependency file`);
    expect(readme).toContain(`${Math.round(100 * groesster.anteil)} % vs ${Math.round(100 * groesster.erwartet)} % in the largest dataset`);
  });
});
