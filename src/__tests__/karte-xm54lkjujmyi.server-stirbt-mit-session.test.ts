/**
 * Karte xm54lkjujmyi — der Server stirbt mit seiner Session, statt sie als
 * brennender Waise zu ueberleben.
 *
 * Der Befund: drei verwaiste MCP-Server, je ~26.700 CPU-Sekunden in 7,4 h
 * (ein Kern pro Waise), ein brennender Thread, null Netzverbindungen. Das
 * SDK hoert auf stdin nur 'data'/'error' — endet der Client, erfaehrt der
 * Server es nie. Dazu der Wachhund gegen die nicht reproduzierte
 * Brand-Restursache: >80 % CPU ohne Werkzeugaufruf, zwei Fenster in Folge.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { beiStdinEnde } from '../stdin-ende.js';
import { starteBrandWachhund, merkeWerkzeugAufruf, _wachhundZuruecksetzen } from '../brand-wachhund.js';

describe('beiStdinEnde', () => {
  it('FINDE: stdin endet (EOF) -> beende genau einmal, mit Grund', () => {
    const s = new PassThrough();
    const gruende: string[] = [];
    beiStdinEnde(s, (g) => gruende.push(g));
    s.resume();
    s.end();
    return new Promise<void>((r) => setImmediate(() => {
      // 'end' und 'close' feuern beide — gemeldet wird trotzdem nur EINMAL.
      expect(gruende).toHaveLength(1);
      expect(gruende[0]).toMatch(/^stdin-/);
      r();
    }));
  });

  it('FINDE: stdin-Fehler (gebrochene Pipe) -> Stream zerstoert UND beende', () => {
    const s = new PassThrough();
    const gruende: string[] = [];
    beiStdinEnde(s, (g) => gruende.push(g));
    s.emit('error', new Error('EPIPE'));
    expect(gruende).toEqual(['stdin-error']);
    // destroy stoppt die Leseschleife der gebrochenen Windows-Pipe sofort —
    // ohne das drehte libuv Fehler-Reads im Kreis (der beobachtete Kernbrand).
    expect(s.destroyed).toBe(true);
  });

  it('GEGENPROBE: solange stdin lebt und Daten traegt, wird NICHT beendet', () => {
    const s = new PassThrough();
    let beendet = 0;
    beiStdinEnde(s, () => beendet++);
    s.write('{"jsonrpc":"2.0"}\n');
    expect(beendet).toBe(0);
  });
});

describe('starteBrandWachhund', () => {
  beforeEach(() => _wachhundZuruecksetzen());

  type Uhrwerk = {
    tick: () => void;
    brenne: (ms: number) => void;
    vergehe: (ms: number) => void;
    warnungen: string[];
    beendet: () => boolean;
  };

  function bauUhrwerk(fensterMs = 1000): Uhrwerk {
    let cpuMikros = 0;
    let zeit = 0;
    let tickFn: (() => void) | null = null;
    const warnungen: string[] = [];
    let beendet = false;
    starteBrandWachhund({
      fensterMs,
      cpu: () => ({ user: cpuMikros, system: 0 }),
      jetzt: () => zeit,
      plane: (fn) => { tickFn = fn; },
      warne: (z) => warnungen.push(z),
      beende: () => { beendet = true; },
    });
    return {
      tick: () => tickFn?.(),
      brenne: (ms) => { cpuMikros += ms * 1000; },
      vergehe: (ms) => { zeit += ms; },
      warnungen,
      beendet: () => beendet,
    };
  }

  it('FINDE: zwei Brand-Fenster ohne Werkzeugaufruf -> Abgang', () => {
    const u = bauUhrwerk();
    u.vergehe(1000); u.brenne(950); u.tick();   // Fenster 1: 95 % CPU, still
    expect(u.warnungen).toHaveLength(1);
    expect(u.beendet()).toBe(false);            // EIN Fenster reicht nicht
    u.vergehe(1000); u.brenne(990); u.tick();   // Fenster 2: brennt weiter
    expect(u.beendet()).toBe(true);
  });

  it('GEGENPROBE: dieselbe CPU-Last MIT Werkzeugaufrufen ist Arbeit, kein Brand', () => {
    const u = bauUhrwerk();
    u.vergehe(1000); u.brenne(950);
    merkeWerkzeugAufruf(() => 900);             // Aufruf innerhalb des Fensters
    u.tick();
    u.vergehe(1000); u.brenne(990);
    merkeWerkzeugAufruf(() => 1900);
    u.tick();
    expect(u.beendet()).toBe(false);
    expect(u.warnungen).toHaveLength(0);
  });

  it('GEGENPROBE: ein einzelnes Brand-Fenster mit ruhigem danach setzt auf null zurueck', () => {
    const u = bauUhrwerk();
    u.vergehe(1000); u.brenne(950); u.tick();   // verdaechtig
    u.vergehe(1000); u.brenne(10); u.tick();    // ruhig -> Zaehler faellt
    u.vergehe(1000); u.brenne(950); u.tick();   // wieder verdaechtig — erst Fenster 1/2
    expect(u.beendet()).toBe(false);
  });

  it('GEGENPROBE: Leerlauf beendet nie', () => {
    const u = bauUhrwerk();
    for (let i = 0; i < 10; i++) { u.vergehe(1000); u.brenne(5); u.tick(); }
    expect(u.beendet()).toBe(false);
    expect(u.warnungen).toHaveLength(0);
  });
});
