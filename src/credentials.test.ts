import { describe, it, expect } from 'vitest';
import { istPlatzhalter, resolveApiKey } from './credentials.js';

/*
 * ── Die stille Variante des Fehlers, den das Plugin beheben soll ────────────
 *
 * Das Claude-Code-Plugin deklariert:
 *
 *     "CACHLY_JWT": "${user_config.api_key}"
 *
 * Setzt der Nutzer den Wert nie, kann bei uns der Text `${user_config.api_key}`
 * selbst ankommen. Er ist "wahr" — also hielte ihn jede Pruefung fuer einen
 * Schluessel. Folge: jede Anfrage 401, und die Selbsteinrichtung springt NICHT
 * an, weil scheinbar ein Schluessel da ist.
 *
 * Der Server liefe. Er koennte nur nichts. Und niemand saehe einen Fehler.
 */
describe('Ein nicht ersetzter Platzhalter ist kein Schluessel', () => {
  it('erkennt die Form ${...}', () => {
    expect(istPlatzhalter('${user_config.api_key}')).toBe(true);
    expect(istPlatzhalter('${user_config.instance_id}')).toBe(true);
    expect(istPlatzhalter('  ${irgendwas}  ')).toBe(true);
    expect(istPlatzhalter('${}')).toBe(true);
  });

  it('haelt einen echten Schluessel NICHT fuer einen Platzhalter', () => {
    // Der teure Fehler waere anders herum: einen gueltigen Schluessel
    // wegzuwerfen, weil das Muster zu gierig ist.
    for (const echt of [
      'cky_live_abc123',
      'cky_trial_abc123',
      'eyJhbGciOiJSUzI1NiJ9.abc.def',
      '${nicht am Ende',
      'text ${mittendrin} text',
      'a${b}',
    ]) {
      expect(istPlatzhalter(echt), echt).toBe(false);
    }
  });

  it('resolveApiKey uebergeht den Platzhalter und faellt weiter', () => {
    const key = resolveApiKey({
      env: { CACHLY_JWT: '${user_config.api_key}', CACHLY_API_KEY: 'cky_live_echt' },
      home: '/kein/pfad',
      cwd: '/kein/pfad',
    });
    expect(key).toBe('cky_live_echt');
  });

  it('nur Platzhalter heisst: KEIN Schluessel, nicht ein leerer', () => {
    // undefined statt '' ist der Unterschied, an dem die Selbsteinrichtung
    // haengt: sie springt bei `!JWT` an.
    const key = resolveApiKey({
      env: { CACHLY_JWT: '${user_config.api_key}' },
      home: '/kein/pfad',
      cwd: '/kein/pfad',
    });
    expect(key).toBeUndefined();
  });
});
