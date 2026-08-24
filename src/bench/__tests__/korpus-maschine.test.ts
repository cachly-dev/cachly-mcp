import { describe, expect, it } from 'vitest';
import {
  ausgangAusCode, istFaellig, naechstes, projekteAusListe, VERSUCHE_MAX,
  type Zustand,
} from '../korpus-maschine.js';

/**
 * Die Erntemaschine haelt fest, WARUM ein Projekt nichts lieferte.
 *
 * Der Unterschied zwischen "leer" und "spaeter" ist der ganze Trick. Wer ihn
 * nicht macht, hat entweder eine Maschine, die tote Projekte jede Nacht neu
 * anfasst, oder eine, die nach einem Netzhaenger ein gutes Projekt fuer
 * immer abschreibt.
 */

describe('Die Liste wird gelesen, nicht geraten', () => {
  it('Kommentare und leere Zeilen fallen weg, Zusatzspalten auch', () => {
    const p = projekteAusListe([
      '# Projektliste',
      '',
      'go-gitea/gitea\t48000\t5100\tsprache:Go',
      'apache/spark\t41000\t900\tgebiet:data-engineering',
    ].join('\n'));
    expect(p).toEqual(['go-gitea/gitea', 'apache/spark']);
  });

  it('KONTROLLE: was kein Projektname ist, kommt nicht durch', () => {
    // Sonst laeuft die Ernte auf eine Ueberschrift oder einen halben Pfad.
    expect(projekteAusListe('nur-ein-wort\nzu/viele/teile\n /kein-besitzer')).toEqual([]);
  });
});

describe('Was noch dran ist und was nicht', () => {
  it('ein unbekanntes Projekt ist dran', () => {
    expect(istFaellig(undefined)).toBe(true);
  });

  it('"leer" wird NIE wieder angefasst', () => {
    /*
     * apache/spark und apache/kafka fuehren ihre Vorgaenge in JIRA, mysql in
     * Oracles Fehlerdatenbank. Dort gibt es "Issue -> gemergter PR" nicht.
     * Ohne Gedaechtnis fragt die Maschine sie jede Nacht neu.
     */
    expect(istFaellig({ ausgang: 'leer', versuche: 1, zuletzt: 'x' })).toBe(false);
  });

  it('"fertig" auch nicht — eine zweite Ernte liefert dasselbe', () => {
    expect(istFaellig({ ausgang: 'fertig', paare: 500, versuche: 1, zuletzt: 'x' })).toBe(false);
  });

  it('"spaeter" schon — aber nicht endlos', () => {
    expect(istFaellig({ ausgang: 'spaeter', versuche: 1, zuletzt: 'x' })).toBe(true);
    expect(istFaellig({ ausgang: 'spaeter', versuche: VERSUCHE_MAX, zuletzt: 'x' })).toBe(false);
  });

  it('"kaputt" ist endgueltig', () => {
    expect(istFaellig({ ausgang: 'kaputt', versuche: 9, zuletzt: 'x' })).toBe(false);
  });
});

describe('Zwei Maschinen laufen aufeinander zu', () => {
  const projekte = ['a/1', 'b/2', 'c/3', 'd/4', 'e/5'];

  it('von vorne nimmt das erste, von hinten das letzte', () => {
    expect(naechstes(projekte, {}, 'vorne')).toBe('a/1');
    expect(naechstes(projekte, {}, 'hinten')).toBe('e/5');
  });

  it('erledigte werden uebersprungen — von beiden Seiten', () => {
    const z: Zustand = {
      'a/1': { ausgang: 'fertig', versuche: 1, zuletzt: 'x' },
      'e/5': { ausgang: 'leer', versuche: 1, zuletzt: 'x' },
    };
    expect(naechstes(projekte, z, 'vorne')).toBe('b/2');
    expect(naechstes(projekte, z, 'hinten')).toBe('d/4');
  });

  it('wenn sie sich treffen, ist nichts mehr offen', () => {
    /*
     * Das ist KEIN Fehler, sondern das Ziel. Eine Maschine, die hier eine
     * Ausnahme wirft, wuerde von ihrem Dienst endlos neu gestartet.
     */
    const z: Zustand = Object.fromEntries(
      projekte.map((p) => [p, { ausgang: 'fertig' as const, versuche: 1, zuletzt: 'x' }]),
    );
    expect(naechstes(projekte, z, 'vorne')).toBeNull();
    expect(naechstes(projekte, z, 'hinten')).toBeNull();
  });
});

describe('Der Ausgang wird an der Bedeutung erkannt', () => {
  it('Code 0 ist fertig', () => {
    expect(ausgangAusCode(0, '500 Paare geschrieben').ausgang).toBe('fertig');
  });

  it('Code 4 heisst: dieses Projekt hat nichts — nicht "Stoerung"', () => {
    // fremdernte.ts setzt genau diesen Code bei "Issues gesehen, kein Paar".
    expect(ausgangAusCode(4, 'NICHT GEERNTET: 12 Issues gesehen, kein einziges Paar.').ausgang)
      .toBe('leer');
  });

  it('ein leeres Kontingent ist spaeter, nicht leer', () => {
    /*
     * Der teuerste Verwechslungsfall. Am 24.08.2026 buchte eine fruehere
     * Fassung zehn von sechzehn Projekten als "keine Paare", weil das
     * Kontingent alle war. Als "leer" gemerkt waeren sie fuer immer weg.
     */
    const a = ausgangAusCode(1, 'GitHub-Kontingent leer — wieder frei in 43 Minuten');
    expect(a.ausgang).toBe('spaeter');
    expect(a.grund).toMatch(/Kontingent/);
  });

  it('Netz und Ueberlastung sind spaeter', () => {
    expect(ausgangAusCode(1, 'NICHT GEERNTET: fetch failed').ausgang).toBe('spaeter');
    expect(ausgangAusCode(1, 'GraphQL: 502 Bad Gateway').ausgang).toBe('spaeter');
    expect(ausgangAusCode(1, 'GitHub brach die Abfrage ab (zu schwer)').ausgang).toBe('spaeter');
  });

  it('ein 404 ist endgueltig — das Repo gibt es nicht mehr', () => {
    // Wer das als "spaeter" liest, fragt fuenfmal nach einem Repo, das
    // geloescht oder umbenannt wurde.
    expect(ausgangAusCode(1, 'GraphQL: 404 Not Found').ausgang).toBe('leer');
  });

  it('KONTROLLE: Unbekanntes ist spaeter, nicht leer', () => {
    /*
     * Die sichere Richtung. Ein unbekannter Fehler faelschlich als "leer" zu
     * merken, verliert ein Projekt lautlos. Faelschlich als "spaeter" kostet
     * fuenf Versuche und meldet sich dann als "kaputt".
     */
    const a = ausgangAusCode(1, 'irgendetwas voellig Neues');
    expect(a.ausgang).toBe('spaeter');
    expect(a.grund).toContain('voellig Neues');
  });
});

describe('Ein gescheitertes Projekt blockiert die Maschine nicht', () => {
  const projekte = ['a/1', 'b/2', 'c/3'];

  it('Unversuchtes kommt vor Wiederholungen', () => {
    /*
     * Gemessen am 24.08.2026 auf node-3: der erste Entwurf nahm immer das
     * erste faellige Projekt. public-apis scheiterte, und der naechste
     * Durchgang nahm GENAU DASSELBE. Fuenf Durchgaenge fuer einen einzigen
     * kaputten Eintrag — und bei einem laengeren Ausfall von GitHub stuende
     * die Maschine stundenlang auf Projekt eins.
     */
    const z: Zustand = { 'a/1': { ausgang: 'spaeter', versuche: 2, zuletzt: 'x' } };
    expect(naechstes(projekte, z, 'vorne')).toBe('b/2');
  });

  it('das Gescheiterte ist trotzdem noch dran, wenn sonst nichts offen ist', () => {
    // Vergessen waere schlimmer als spaet. Ein Netzhaenger darf ein gutes
    // Projekt nicht kosten.
    const z: Zustand = {
      'a/1': { ausgang: 'spaeter', versuche: 2, zuletzt: 'x' },
      'b/2': { ausgang: 'fertig', versuche: 1, zuletzt: 'x' },
      'c/3': { ausgang: 'leer', versuche: 1, zuletzt: 'x' },
    };
    expect(naechstes(projekte, z, 'vorne')).toBe('a/1');
  });

  it('bei gleicher Versuchszahl entscheidet die Richtung', () => {
    const z: Zustand = {
      'a/1': { ausgang: 'spaeter', versuche: 1, zuletzt: 'x' },
      'b/2': { ausgang: 'spaeter', versuche: 1, zuletzt: 'x' },
      'c/3': { ausgang: 'spaeter', versuche: 1, zuletzt: 'x' },
    };
    expect(naechstes(projekte, z, 'vorne')).toBe('a/1');
    expect(naechstes(projekte, z, 'hinten')).toBe('c/3');
  });

  it('KONTROLLE: das wenigst Versuchte gewinnt, egal wo es steht', () => {
    const z: Zustand = {
      'a/1': { ausgang: 'spaeter', versuche: 3, zuletzt: 'x' },
      'b/2': { ausgang: 'spaeter', versuche: 4, zuletzt: 'x' },
      'c/3': { ausgang: 'spaeter', versuche: 1, zuletzt: 'x' },
    };
    expect(naechstes(projekte, z, 'vorne')).toBe('c/3');
  });
});

describe('Das ERGEBNIS schlaegt den Rueckgabecode', () => {
  it('geschriebene Paare sind fertig, egal was der Code sagt', () => {
    /*
     * Gemessen am 24.08.2026 auf node-4: `inducer/pycuda` wurde als
     * "spaeter" gebucht. Die Ernte war ERFOLGREICH — 7 Paare geschrieben.
     * Sie endet nur mit einem Warncode, weil unter 30 Paaren "keine Aussage"
     * traegt. Die Maschine warf ihre eigene Arbeit weg.
     */
    expect(ausgangAusCode(1, 'Weniger als 30 Paare — das traegt keine Aussage.', 7).ausgang)
      .toBe('fertig');
  });

  it('KONTROLLE: ohne Paare gilt der Code weiter', () => {
    // Sonst waere ALLES fertig und die Maschine merkte nie einen Fehler.
    expect(ausgangAusCode(4, 'kein einziges Paar', 0).ausgang).toBe('leer');
  });

  it('eine Zahl mitten im Text ist kein Serverfehler', () => {
    /*
     * Der eigentliche Fehler. Das Muster suchte 50[024] IRGENDWO und traf:
     *
     *     Kosten: 2 Punkte · 4258 von 5000 uebrig
     *                                 ^^^^
     *
     * Ein erfolgreicher Lauf wurde als Serverfehler gebucht. Zum vierten Mal
     * an einem Tag: ein Waechter, der auf die Schreibweise sieht statt auf
     * die Bedeutung.
     */
    const echt = ausgangAusCode(1, 'Kosten: 2 Punkte · 4258 von 5000 uebrig', 0);
    expect(echt.grund).not.toBe('Netz oder Server');
  });

  it('KONTROLLE: an der richtigen Stelle wird er erkannt', () => {
    expect(ausgangAusCode(1, 'GraphQL: 502 Bad Gateway', 0).grund).toBe('Netz oder Server');
    expect(ausgangAusCode(1, 'HTTP 504 Gateway Timeout', 0).grund).toBe('Netz oder Server');
  });

  it('KONTROLLE: 5000 und 4041 loesen nichts aus', () => {
    // Zahlen aus Kontingent- und Zeilenangaben duerfen nie ein Urteil sein.
    expect(ausgangAusCode(1, 'noch 5000 Punkte, 4041 Zeilen gelesen', 0).ausgang).toBe('spaeter');
    expect(ausgangAusCode(1, 'noch 5000 Punkte, 4041 Zeilen gelesen', 0).grund)
      .not.toBe('nicht zugaenglich');
  });
});
