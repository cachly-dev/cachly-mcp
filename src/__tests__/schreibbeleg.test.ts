/**
 * Schreibbeleg: "gespeichert" ohne Schreibaufruf wird erkannt.
 *
 * Gegenprobe: setzt man in `stopAntwort` die Bedingung `b.erfolgreich === 0`
 * auf `false`, faellt "nur behauptet" — die Pruefung waere dann Dekoration.
 */

import { describe, it, expect } from 'vitest';
import { belegFuer, behauptetSpeicherung, pruefeZug, stopAntwort } from '../schreibbeleg.js';

const nutzer = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const antwort = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const aufruf = (id: string, name = 'mcp__cachly__learn_from_attempts') =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] } });
const ergebnis = (id: string, text: string, is_error = false) =>
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error }] },
  });

const BEHAUPTUNG = 'Erledigt. Die Lektion ist im Brain gespeichert.';

describe('belegFuer', () => {
  it('ist kurz, stabil und haengt am Inhalt', () => {
    const a = belegFuer('deploy:api', '2026-10-07T10:00:00Z', 'nohup docker compose up -d');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(belegFuer('deploy:api', '2026-10-07T10:00:00Z', 'nohup docker compose up -d')).toBe(a);
    expect(belegFuer('deploy:api', '2026-10-07T10:00:00Z', 'anders')).not.toBe(a);
  });
});

describe('behauptetSpeicherung', () => {
  it.each([
    'Die Lektion ist im Brain gespeichert.',
    'Ich habe das ins Brain geschrieben.',
    'Lesson stored in cachly.',
    'Saved to the brain for next time.',
    'Das steht jetzt als Lektion im Gedächtnis festgehalten.',
    'Die Lücke steht als kritische Lektion im Brain (`sicherheit:x`).',
    'Recorded it as a new lesson.',
  ])('erkennt: %s', (t) => expect(behauptetSpeicherung(t)).toBe(true));

  it.each([
    'Die Datei ist gespeichert.',
    'Der Test lief gruen.',
    'Soll ich das als Lektion speichern?',
    'Wenn du willst, lege ich das als Lektion ab.',
    'Want me to save this as a lesson?',
    // Fehlalarme aus 414 echten Zuegen (07.10.2026):
    '| **Türsteher** | je neue Lektion drei Fragen | nichts — heute wird gespeichert, was kommt |',
    'Bei 3.003 Fragen, die absichtlich anders formuliert sind als die Lektion.',
  ])('laesst durch: %s', (t) => expect(behauptetSpeicherung(t)).toBe(false));
});

describe('pruefeZug / stopAntwort', () => {
  it('echte Speicherung: kein Einwand', () => {
    const z = [nutzer('merk dir das'), aufruf('t1'), ergebnis('t1', '✅ **Lesson stored:** `x` · Beleg: `ab12cd34`'), antwort(BEHAUPTUNG)];
    expect(pruefeZug(z).erfolgreich).toBe(1);
    expect(stopAntwort(z, false)).toBe('');
  });

  it('nur behauptet: zurueckgeschickt', () => {
    const z = [nutzer('merk dir das'), antwort(BEHAUPTUNG)];
    const out = JSON.parse(stopAntwort(z, false));
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('kein Schreibaufruf');
  });

  it('Aufruf abgewiesen (grund fehlt): zurueckgeschickt', () => {
    const z = [nutzer('x'), aufruf('t1'), ergebnis('t1', '✋ **Update abgewiesen:** `x` existiert bereits'), antwort(BEHAUPTUNG)];
    expect(JSON.parse(stopAntwort(z, false)).reason).toContain('abgewiesen');
  });

  it('Werkzeugfehler: zurueckgeschickt', () => {
    const z = [nutzer('x'), aufruf('t1'), ergebnis('t1', 'boom', true), antwort(BEHAUPTUNG)];
    expect(stopAntwort(z, false)).not.toBe('');
  });

  it('erfundener Beleg: zurueckgeschickt, auch mit echtem Aufruf', () => {
    const z = [
      nutzer('x'),
      aufruf('t1'),
      ergebnis('t1', '✅ **Lesson stored:** `x` · Beleg: `ab12cd34`'),
      antwort('Gespeichert, Beleg: `deadbeef`.'),
    ];
    expect(JSON.parse(stopAntwort(z, false)).reason).toContain('deadbeef');
  });

  it('nur der letzte Zug zaehlt — ein frueherer Aufruf deckt keine neue Behauptung', () => {
    const z = [nutzer('a'), aufruf('t1'), ergebnis('t1', '✅ ok'), antwort('ok'), nutzer('b'), antwort(BEHAUPTUNG)];
    expect(stopAntwort(z, false)).not.toBe('');
  });

  it('Hintergrund-Meldung und Skill-Text beenden den Zug nicht', () => {
    const meldung = JSON.stringify({
      type: 'user',
      origin: { kind: 'task-notification' },
      message: { role: 'user', content: '<task-notification>fertig</task-notification>' },
    });
    const skill = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Approach this as…' }] } });
    const z = [nutzer('x'), aufruf('t1'), ergebnis('t1', '✅ ok'), meldung, skill, antwort('Als Lektion gespeichert.')];
    expect(stopAntwort(z, false)).toBe('');
  });

  it('keine Behauptung, kein Aufruf: kein Einwand', () => {
    expect(stopAntwort([nutzer('x'), antwort('Der Test ist gruen.')], false)).toBe('');
  });

  it('nie zweimal hintereinander (stop_hook_active)', () => {
    expect(stopAntwort([nutzer('x'), antwort(BEHAUPTUNG)], true)).toBe('');
  });

  it('Nebenagenten und kaputte Zeilen stoeren nicht', () => {
    const neben = JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: BEHAUPTUNG }] } });
    expect(stopAntwort([nutzer('x'), '{kaputt', neben, antwort('fertig')], false)).toBe('');
  });
});
