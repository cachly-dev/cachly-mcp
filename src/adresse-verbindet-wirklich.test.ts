/**
 * Eine Verbindungsadresse muss verbinden koennen.
 *
 * ── Der Vorfall ──────────────────────────────────────────────────────────────
 *
 * Am 19.08.2026 gab `get_connection_string` das hier zurueck:
 *
 *   redis://49.13.38.27:30114
 *
 *   Quick test:
 *   redis-cli -u "redis://49.13.38.27:30114" PING
 *
 * Der Quick test scheitert an NOAUTH. Das Passwort fehlte.
 *
 * Der Grund ist derselbe wie beim Export am selben Tag: das Werkzeug las den
 * allgemeinen Instanz-Datensatz (/instances/:id) statt der Zugangsdaten
 * (/instances/:id/connection). Der erste fuehrt kein Passwort, und das ist
 * richtig so. Zwei Fragen, eine Quelle.
 *
 * ── Was dieser Waechter prueft ───────────────────────────────────────────────
 *
 * Nicht "steht ein @ drin" — das waere die Antwort auf genau diesen einen
 * Vorfall. Sondern: kommt die Adresse von der Stelle, die sie vollstaendig
 * kennt, und faellt es auf, wenn sie es nicht tut.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleInstanceTool } from './handlers/instances.js';

const INSTANZ = {
  id: 'i-1', name: 'my-brain', status: 'running', tier: 'free', memory_mb: 256,
  region: 'eu', host: '49.13.38.27', port: 30114, tls_enabled: false,
  // Kein Passwort — genau wie der echte Endpunkt /instances/:id es liefert.
};

/** Ein apiFetch, das beide Endpunkte kennt und mitschreibt, wer gerufen wurde. */
function apiAttrappe(verbindung: Record<string, unknown> | null) {
  const gerufen: string[] = [];
  const fetch = vi.fn(async (pfad: string) => {
    gerufen.push(pfad);
    if (pfad.endsWith('/connection')) {
      if (!verbindung) throw new Error('connection HTTP 404');
      return verbindung;
    }
    return INSTANZ;
  });
  return { fetch: fetch as never, gerufen };
}

describe('get_connection_string: die Adresse muss verbinden koennen', () => {
  it('fragt die Zugangsdaten dort, wo sie stehen', async () => {
    const api = apiAttrappe({
      connection_string: 'redis://:geheim@49.13.38.27:30114',
      password: 'geheim', host: '49.13.38.27', port: 30114,
    });
    await handleInstanceTool('get_connection_string', { instance_id: 'i-1' }, (() => {}) as never, api.fetch);

    // Der allgemeine Datensatz allein reicht nicht — er fuehrt kein Passwort.
    expect(api.gerufen.some((p) => p.endsWith('/connection'))).toBe(true);
  });

  it('gibt die Adresse MIT Passwort heraus', async () => {
    const api = apiAttrappe({
      connection_string: 'redis://:geheim@49.13.38.27:30114',
      password: 'geheim',
    });
    const text = await handleInstanceTool('get_connection_string', { instance_id: 'i-1' }, (() => {}) as never, api.fetch);

    expect(text).toContain('redis://:geheim@49.13.38.27:30114');
    // Der Quick test ist das, was der Nutzer als erstes ausprobiert. Steht dort
    // eine Adresse ohne Passwort, hat das Werkzeug ihn in einen Fehler geschickt.
    const quickTest = String(text).split('Quick test:')[1] ?? '';
    expect(quickTest).toContain('geheim');
  });

  it('baut die Adresse nicht selbst zusammen, wenn der Server sie liefert', async () => {
    // Der Kern der Sache: es darf nur EINE Stelle geben, die weiss, wie eine
    // Adresse aussieht. Liefert der Server eine, wird sie benutzt — auch wenn
    // sie anders aussieht, als dieses Modul sie bauen wuerde.
    const api = apiAttrappe({
      connection_string: 'rediss://:pw@anderer-host.example:6380/2',
      password: 'pw',
    });
    const text = await handleInstanceTool('get_connection_string', { instance_id: 'i-1' }, (() => {}) as never, api.fetch);

    expect(text).toContain('rediss://:pw@anderer-host.example:6380/2');
    expect(text).not.toContain('49.13.38.27:30114');
  });

  it('warnt, wenn ein Passwort da ist, aber nicht in der Adresse steht', async () => {
    // Der Fall, der am 19.08. still passiert ist. Er darf nicht mehr still sein.
    const api = apiAttrappe({
      connection_string: 'redis://49.13.38.27:30114', // ohne @ — das ist der Fehler
      password: 'geheim',
    });
    const text = await handleInstanceTool('get_connection_string', { instance_id: 'i-1' }, (() => {}) as never, api.fetch);

    expect(text).toMatch(/⚠️/);
  });

  it('faellt zurueck, wenn der Endpunkt fehlt — und sagt es laut', async () => {
    // Aeltere oder eingeschraenkte Server. Eine unvollstaendige Adresse ist
    // dann besser als ein Absturz — aber nur, wenn danebensteht, dass sie
    // unvollstaendig ist. Eine stille Teilantwort waere genau der Fehler,
    // den dieser Waechter abschafft.
    const api = apiAttrappe(null);
    const text = await handleInstanceTool('get_connection_string', { instance_id: 'i-1' }, (() => {}) as never, api.fetch);

    expect(text).toContain('redis://49.13.38.27:30114');
    expect(text).toMatch(/NOAUTH/);
  });
});
