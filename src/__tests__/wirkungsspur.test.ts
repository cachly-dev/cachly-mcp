import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  pruefeWirkung,
  lehrwert,
  werteAus,
  leiteAb,
  SICHTBARE_PLAETZE,
  type Wirkungseintrag,
} from '../wirkungsspur.js';

/**
 * ══ Die Wirkungsspur ═══════════════════════════════════════════════════════
 *
 * ── Warum es das bis zum 23.08.2026 nicht gab ─────────────────────────────
 *
 * Jede Kennzahl dieses Produkts zaehlte ANZEIGEN, keine WIRKUNG:
 *
 *     recall_count    die Lektion wurde ausgegeben
 *     ROI-Stunden     Anzeigen mal einer Schaetzung
 *     team_confirm    ein Mensch findet sie allgemein gut
 *
 * Nirgends stand: DIESE Lektion hat GENAU DIESE Frage beantwortet.
 *
 * ── Was ohne diese Spur nicht geht ───────────────────────────────────────
 *
 * Gemessen am 23.08.2026 am echten Bestand (499 Lektionen, 100 Fragen):
 * 97 Prozent im Topf, 71 in den Top 10, 55 in den Top 3, 41 auf Platz 1.
 * Das Finden ist geloest — alle 56 verlorenen Punkte entstehen beim ORDNEN.
 * Und die Gewichte dieser Ordnung sind von Hand abgetastet.
 *
 * Mit dieser Spur werden sie lernbar.
 */

const JETZT = '2026-08-23T20:00:00.000Z';

const gueltig = {
  frage: 'warum bricht der Deploy ab',
  thema: 'ci:zeitgrenze-meldet-cancelled',
  geholfen: true,
  platz: 0,
};

describe('Was als Rueckmeldung durchgeht', () => {
  it('nimmt eine vollstaendige Angabe an', () => {
    const e = pruefeWirkung(gueltig, JETZT);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.eintrag.ts).toBe(JETZT);
    expect(e.eintrag.thema).toBe('ci:zeitgrenze-meldet-cancelled');
  });

  it('lehnt "weiss nicht" ab', () => {
    // Eine Trainingsspur mit geratenen Werten ist schlimmer als gar keine.
    // Deshalb gibt es fuer `geholfen` keine dritte Moeglichkeit.
    const e = pruefeWirkung({ ...gueltig, geholfen: 'vielleicht' }, JETZT);
    expect(e.ok).toBe(false);
    if (e.ok) return;
    expect(e.grund).toContain('true oder false');
  });

  it('lehnt einen geschaetzten Platz ab', () => {
    for (const platz of [-1, 1.5, '3', null, undefined]) {
      const e = pruefeWirkung({ ...gueltig, platz }, JETZT);
      expect(e.ok, `platz=${String(platz)} wurde angenommen`).toBe(false);
    }
  });

  it('verlangt die Frage im Wortlaut', () => {
    // Nicht eine Zusammenfassung: die Sortierung muss aus der echten
    // Formulierung lernen.
    expect(pruefeWirkung({ ...gueltig, frage: '   ' }, JETZT).ok).toBe(false);
    expect(pruefeWirkung({ ...gueltig, thema: '' }, JETZT).ok).toBe(false);
  });

  it('kuerzt sehr lange Texte, statt sie abzulehnen', () => {
    const e = pruefeWirkung({ ...gueltig, frage: 'x'.repeat(2000) }, JETZT);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    expect(e.eintrag.frage.length).toBe(500);
  });

  it('GEGENPROBE: die Pruefung laesst nicht einfach alles durch', () => {
    // Ohne diese Zeile koennte pruefeWirkung immer ok:true liefern und jede
    // Ablehnung oben waere gruen, ohne etwas zu pruefen.
    expect(pruefeWirkung({}, JETZT).ok).toBe(false);
  });
});

describe('Was eine Rueckmeldung lehrt', () => {
  const fall = (geholfen: boolean, platz: number) => lehrwert({ geholfen, platz });

  it('geholfen, aber gar nicht in der Antwort — der wertvollste Fall', () => {
    // Der Fall, den ein naiver Entwurf vergisst: er fragt nur nach dem, was
    // angezeigt wurde. Genau hier sagt die Spur, dass der Topf versagt hat.
    expect(fall(true, 0)).toBe('fehlender-treffer');
  });

  it('geholfen, aber weit hinten — die Sortierung war zu schwach', () => {
    expect(fall(true, 7)).toBe('zu-weit-hinten');
    expect(fall(true, SICHTBARE_PLAETZE + 1)).toBe('zu-weit-hinten');
  });

  it('vorn und falsch — harter Gegenbeleg', () => {
    expect(fall(false, 1)).toBe('falsch-und-sicher');
    expect(fall(false, SICHTBARE_PLAETZE)).toBe('falsch-und-sicher');
  });

  it('vorn und richtig — Bestaetigung, am wenigsten wert', () => {
    expect(fall(true, 1)).toBe('bestaetigung');
    expect(fall(true, SICHTBARE_PLAETZE)).toBe('bestaetigung');
  });

  it('hinten und nicht hilfreich — sagt wenig', () => {
    expect(fall(false, 20)).toBe('unauffaellig');
    expect(fall(false, 0)).toBe('unauffaellig');
  });

  it('GEGENPROBE: die fuenf Faelle sind wirklich verschieden', () => {
    const alle = new Set([
      fall(true, 0), fall(true, 7), fall(false, 1), fall(true, 1), fall(false, 20),
    ]);
    expect(alle.size).toBe(5);
  });

  it('die Grenze liegt bei drei, weil der Mensch drei sieht', () => {
    expect(SICHTBARE_PLAETZE).toBe(3);
    expect(fall(true, 3)).toBe('bestaetigung');
    expect(fall(true, 4)).toBe('zu-weit-hinten');
  });
});

describe('Die Auswertung misst die Sortierung, nicht die Lektionen', () => {
  const e = (geholfen: boolean, platz: number): Wirkungseintrag => ({
    ts: JETZT, quelle: 'gemeldet', frage: 'f', thema: 't', geholfen, platz, notiz: '', autor: '',
  });

  it('die Trefferquote zaehlt nur die Faelle, in denen etwas geholfen hat', () => {
    // "Anteil geholfen" waere eine Zahl ueber die LEKTIONEN. Gefragt ist die
    // Zahl ueber die SORTIERUNG: von allen Faellen mit einer hilfreichen
    // Lektion, wie oft stand sie unter den ersten dreien?
    const spur = [e(true, 1), e(true, 9), e(false, 1), e(false, 30)];
    const z = werteAus(spur);
    expect(z.gesamt).toBe(4);
    expect(z.geholfen).toBe(2);
    expect(z.trefferquote).toBeCloseTo(0.5, 5);
  });

  it('ohne einen einzigen hilfreichen Fall gibt es keine Quote', () => {
    // Nicht 0 Prozent: das waere eine Aussage, die niemand gemessen hat.
    // Dieselbe Regel wie beim Zustand "nicht_gemessen" im Waechter.
    expect(werteAus([]).trefferquote).toBeNull();
    expect(werteAus([e(false, 2)]).trefferquote).toBeNull();
  });

  it('ein fehlender Treffer zieht die Quote herunter', () => {
    const z = werteAus([e(true, 1), e(true, 0)]);
    expect(z.trefferquote).toBeCloseTo(0.5, 5);
    expect(z.nachLehrwert['fehlender-treffer']).toBe(1);
  });

  it('GEGENPROBE: die Zaehlung summiert sich wirklich auf', () => {
    const spur = [e(true, 0), e(true, 9), e(false, 1), e(true, 2), e(false, 40)];
    const z = werteAus(spur);
    const summe = Object.values(z.nachLehrwert).reduce((a, b) => a + b, 0);
    expect(summe).toBe(spur.length);
  });
});

describe('Der automatische Weg — ohne Zutun eines Herstellers', () => {
  const recall = { frage: 'warum bricht der Deploy ab', themen: ['a:eins', 'b:zwei', 'c:drei'] };

  it('das Oeffnen einer angebotenen Lektion liefert ihren Platz', () => {
    // Beide Ereignisse gehen ohnehin durch den Server. Es braucht keine
    // Absprache mit irgendeiner IDE oder irgendeinem Modell.
    const e = leiteAb(recall, 'b:zwei', JETZT);
    expect(e).not.toBeNull();
    expect(e!.platz).toBe(2);
    expect(e!.frage).toBe(recall.frage);
  });

  it('eine Lektion, die gar nicht angeboten wurde, ergibt Platz 0', () => {
    // Der wertvollste Fall, und er faellt hier automatisch an: der Mensch
    // kannte sie beim Namen, die Suche hat sie nicht gefunden.
    const e = leiteAb(recall, 'z:unbekannt', JETZT);
    expect(e!.platz).toBe(0);
    expect(e!.notiz).toContain('nicht in der Antwort');
  });

  it('ohne vorherige Suche wird NICHTS abgeleitet', () => {
    // Wer eine Lektion direkt beim Namen aufruft, hat nichts ausgewaehlt.
    // Daraus einen Beleg zu machen waere erfunden.
    expect(leiteAb(null, 'a:eins', JETZT)).toBeNull();
    expect(leiteAb(undefined, 'a:eins', JETZT)).toBeNull();
    expect(leiteAb({ frage: '', themen: ['a:eins'] }, 'a:eins', JETZT)).toBeNull();
  });

  it('eine abgeleitete Zeile sagt AUSGEWAEHLT, nicht GELOEST', () => {
    const e = leiteAb(recall, 'a:eins', JETZT);
    expect(e!.quelle).toBe('abgeleitet');
    expect(e!.notiz).toContain('automatisch');
  });

  it('gemeldet und abgeleitet fallen NIE in dieselbe Zahl', () => {
    // Das ist der Kern. Auswahl als Hilfe zu verbuchen waere genau die
    // Luege, gegen die diese Spur gebaut ist — die ROI-Stunden zaehlten
    // Anzeigen als Wert, recall_count zaehlt Anzeigen als Nutzung.
    const gemeldetSchlecht = pruefeWirkung(
      { frage: 'f', thema: 'a:eins', geholfen: true, platz: 9 }, JETZT,
    );
    expect(gemeldetSchlecht.ok).toBe(true);
    if (!gemeldetSchlecht.ok) return;

    const spur = [
      gemeldetSchlecht.eintrag,          // gemeldet, hilfreich, Platz 9
      leiteAb(recall, 'a:eins', JETZT)!, // abgeleitet, Platz 1
      leiteAb(recall, 'b:zwei', JETZT)!, // abgeleitet, Platz 2
    ];
    const z = werteAus(spur);

    expect(z.gemeldet).toBe(1);
    expect(z.abgeleitet).toBe(2);
    // Der eine gemeldete hilfreiche Fall stand auf Platz 9 — also 0 Prozent.
    expect(z.trefferquote).toBe(0);
    // Die beiden Auswahlen standen vorn — 100 Prozent, GETRENNT ausgewiesen.
    expect(z.auswahlquote).toBe(1);
  });

  it('GEGENPROBE: ohne die Trennung waere die Zahl geschoent', () => {
    // Wuerde man alles zusammenwerfen, kaeme aus demselben Material
    // 2 von 3 statt 0 von 1 heraus. Genau diese Schoenung soll nicht
    // passieren.
    const gemeldet = pruefeWirkung(
      { frage: 'f', thema: 'a:eins', geholfen: true, platz: 9 }, JETZT,
    );
    if (!gemeldet.ok) throw new Error('Aufbau kaputt');
    const alle = [gemeldet.eintrag, leiteAb(recall, 'a:eins', JETZT)!, leiteAb(recall, 'b:zwei', JETZT)!];
    const naivSichtbar = alle.filter((e) => e.platz > 0 && e.platz <= SICHTBARE_PLAETZE).length;
    expect(naivSichtbar / alle.length).toBeCloseTo(2 / 3, 5);
    expect(werteAus(alle).trefferquote).toBe(0);
  });
});

describe('Das Werkzeug ist wirklich angemeldet', () => {
  const WURZEL = resolve(__dirname, '..');
  const lies = (p: string) => readFileSync(resolve(WURZEL, p), 'utf8').replace(/\r\n/g, '\n');

  it('es steht in der Werkzeugliste', () => {
    // Ein Werkzeug, das nur im Handler existiert, ruft niemand auf — es
    // erscheint gar nicht erst in der Liste, die das Modell sieht.
    expect(lies('tools.ts')).toContain("name: 'recall_feedback'");
  });

  it('der Handler kennt es', () => {
    expect(lies('handlers/brain.ts')).toContain("case 'recall_feedback':");
  });

  it('die Beschreibung erklaert rank=0 — sonst nutzt es niemand richtig', () => {
    // Der wertvollste Fall ist der unintuitivste. Steht er nicht in der
    // Beschreibung, kommt er nie in den Daten vor.
    const tools = lies('tools.ts');
    const ab = tools.indexOf("name: 'recall_feedback'");
    const block = tools.slice(ab, ab + 2500);
    expect(block).toContain('rank=0');
    expect(block).toMatch(/NOT in the answer/i);
  });

  it('die Spur wird ANGEHAENGT, nicht ueberschrieben', () => {
    // Trainingsdaten. Ein `set` statt `rpush` waere lautlos und wuerde jede
    // frueherer Rueckmeldung verlieren.
    const brain = lies('handlers/brain.ts');
    const ab = brain.indexOf("case 'recall_feedback':");
    const block = brain.slice(ab, brain.indexOf("case 'recall_best_solution':", ab));
    expect(block).toContain('rpush');
    expect(block).not.toMatch(/redis\.set\(\s*schluessel/);
  });
});
