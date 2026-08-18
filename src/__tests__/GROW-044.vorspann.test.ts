import { describe, it, expect } from 'vitest';
import { pruefeVorspann, vorspannHinweis, VORSPANN_ZEICHEN } from '../vorspann';

/**
 * GROW-044 — Die 100-Zeichen-Regel wird geprueft, nicht geglaubt.
 *
 * GEMESSEN am 16.08.2026: Das Session-Briefing zeigt je Lektion rund 100
 * Zeichen. In `node4:einrichtung-contabo-und-fallen` stand die gesuchte
 * Adresse `10.8.0.7` an Zeichen 323. Die Lektion war eingeblendet, der Fehler
 * passierte trotzdem.
 *
 * Die Abhilfe stand seither als Schreibregel in CLAUDE.md. Eine Regel, die
 * kein Skript prueft, ist ein Wunsch.
 */
describe('pruefeVorspann', () => {
  it('erkennt eine Adresse ganz vorn', () => {
    const b = pruefeVorspann('WHISPER LAEUFT AUF node-4 UNTER 10.8.0.7:3095 MIT large-v3');
    expect(b.traegtTatsache).toBe(true);
    expect(b.gefunden).toContain('IP-Adresse');
  });

  it('der echte Fall von damals: die Adresse steht zu weit hinten', () => {
    // Nachgebaut nach node4:einrichtung-contabo-und-fallen — erst Anlass und
    // Ausstattung, dann die Adresse.
    const text =
      'Fuer die neue Bauerei wurde ein Server bei einem Anbieter in Frankreich beschafft und eingerichtet, ' +
      'zunaechst mit dem ueblichen Grundsystem und den bekannten Zugaengen, danach in das bestehende ' +
      'Netz aufgenommen; erreichbar ist er unter der Adresse 10.8.0.7 im Tunnel.';
    const b = pruefeVorspann(text);
    expect(b.traegtTatsache).toBe(false);
    expect(b.tatsacheStehtSpaeter).toBe(true);
    expect(b.ersteTatsacheBei).toBeGreaterThan(VORSPANN_ZEICHEN);
  });

  it('erkennt einen Befehl in Rueckwaerts-Anfuehrung', () => {
    expect(pruefeVorspann('Fix: `docker restart llm-gateway` statt compose up.').traegtTatsache).toBe(true);
  });

  it('erkennt einen Dateinamen', () => {
    expect(pruefeVorspann('Der Deckel sitzt in brain.ts und war auf null gesetzt.').traegtTatsache).toBe(true);
  });

  it('erkennt einen Namen in Grossbuchstaben (Umgebungsvariable)', () => {
    expect(pruefeVorspann('CACHLY_API_INTERNAL_BIND setzen, sonst streiten zwei Dienste.').traegtTatsache).toBe(true);
  });

  it('GEGENPROBE: ein betontes Wort in Grossbuchstaben ist noch keine Tatsache', () => {
    // Sonst gilt jede Hervorhebung als harte Angabe und der Waechter schweigt
    // immer — ein Waechter, der nie ausschlaegt, beweist nichts.
    expect(pruefeVorspann('WICHTIG: kuenftig sorgfaeltiger arbeiten und frueher abstimmen.').traegtTatsache).toBe(false);
  });

  it('GEGENPROBE: reine Prosa ohne jede harte Angabe faellt durch', () => {
    const b = pruefeVorspann(
      'Wir haben die Zusammenarbeit verbessert und achten kuenftig staerker darauf, dass alle Beteiligten fruehzeitig eingebunden werden.',
    );
    expect(b.traegtTatsache).toBe(false);
    // Kein "steht spaeter": es gibt gar keine Tatsache, nur eine Haltung.
    expect(b.tatsacheStehtSpaeter).toBe(false);
    expect(b.ersteTatsacheBei).toBe(-1);
  });

  it('GEGENPROBE: nur die ersten 100 Zeichen zaehlen, nicht der ganze Text', () => {
    const spaet = 'x'.repeat(150) + ' 10.8.0.7';
    expect(pruefeVorspann(spaet).traegtTatsache).toBe(false);
    expect(pruefeVorspann(spaet).vorspann.length).toBe(VORSPANN_ZEICHEN);
  });

  it('leerer oder fehlender Text stuerzt nicht ab', () => {
    for (const w of ['', '   ', null, undefined]) {
      const b = pruefeVorspann(w);
      expect(b.traegtTatsache).toBe(false);
      expect(b.tatsacheStehtSpaeter).toBe(false);
    }
  });
});

describe('vorspannHinweis', () => {
  it('schweigt, wenn die Tatsache vorn steht', () => {
    expect(vorspannHinweis('Port 3201 doppelt belegt — CACHLY_API_INTERNAL_BIND setzen.')).toBeNull();
  });

  it('schweigt bei leerem Text — dort ist nichts umzustellen', () => {
    expect(vorspannHinweis('')).toBeNull();
    expect(vorspannHinweis(null)).toBeNull();
  });

  it('nennt die POSITION, wenn die Tatsache nur zu weit hinten steht', () => {
    const text = 'Ein langer erzaehlender Vorlauf ohne jede harte Angabe, der einfach immer weiter geht und nichts sagt, bis endlich 10.8.0.7 kommt.';
    const h = vorspannHinweis(text);
    expect(h).toBeTruthy();
    // Ohne Zahl waere der Hinweis eine Ermahnung; mit Zahl ist er eine
    // Anweisung, die man in zehn Sekunden befolgen kann.
    expect(h).toMatch(/Zeichen \d+/);
    expect(h).toContain('what_worked');
  });

  it('sagt bei reiner Prosa etwas ANDERES als bei falscher Reihenfolge', () => {
    const prosa = vorspannHinweis('Wir arbeiten jetzt sorgfaeltiger und stimmen uns haeufiger ab als vorher.');
    const spaet = vorspannHinweis(
      'Ein langer erzaehlender Vorlauf ganz ohne harte Angabe, der beschreibt wie es dazu kam und wer alles ' +
        'beteiligt war und was man sich dabei gedacht hat, bis endlich 10.8.0.7 kommt.',
    );
    expect(prosa).toBeTruthy();
    expect(spaet).toBeTruthy();
    expect(prosa).not.toBe(spaet);
    expect(prosa).not.toMatch(/Zeichen \d+ /);
  });
});
