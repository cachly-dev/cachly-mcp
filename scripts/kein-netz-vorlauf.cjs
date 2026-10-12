/**
 * Netzsperre fuer Testlaeufe: nach aussen darf nichts verbunden werden.
 *
 * ── Warum es das gibt (12.10.2026) ──────────────────────────────────────────
 *
 * Beim Pruefen der Einblendung wurde das gebuendelte Hook-Paket von Hand rund
 * 50-mal gestartet, mit einer erfundenen Instanz-Kennung und ohne
 * CACHLY_API_URL. Jeder Lauf meldete sein Ledger-Ereignis an die
 * PRODUKTIONS-API (POST .../ambient-events, 401). fail2ban auf node-1 sperrte
 * daraufhin die eigene IP fuer 6 Stunden.
 *
 * Kein Test in diesem Paket hat das getan — aber nichts HAETTE es verhindert.
 * Diese Datei ist die Wurzel-Abhilfe: sie sperrt jede TCP-Verbindung zu einem
 * Ziel ausserhalb dieses Rechners (Loopback ausgenommen). Dadurch kann weder
 * ein Test noch ein von einem Test gestarteter Prozess still die Produktion
 * treffen. Bestehende Tests mit eigenem Attrappen-Server (127.0.0.1) laufen
 * unveraendert.
 *
 * ── Wie ──────────────────────────────────────────────────────────────────────
 *
 * Haengt sich an net.Socket.prototype.connect: fetch (undici), http(s),
 * tls.connect und net.connect gehen alle dort durch. Der Versuch scheitert
 * wie eine verweigerte Verbindung (Fehler am Socket, ECACHLYNETZSPERRE), damit
 * Produktcode mit "bestes Bemuehen"-catch weiterlaeuft wie bei einem Ausfall —
 * wird aber GEZAEHLT:
 *
 *   * im Testprozess: zustand.verstoesse; src/__tests__/kein-netz.setup.ts
 *     laesst nach jedem Test den Test rot werden, wenn dort etwas steht
 *     (auch dann, wenn der Produktcode den Fehler verschluckt hat);
 *   * in jedem Prozess: eine Zeile in der Datei CACHLY_NETZSPERRE_LOG;
 *     src/__tests__/kein-netz.global.ts liest sie am Ende des Laufs und
 *     laesst den ganzen Lauf rot werden. Das erfasst auch Kindprozesse, die
 *     ein Test startet (der Vorlauf reist ueber NODE_OPTIONS mit).
 *
 * Eingeschaltet von vitest.config.ts. Abschalten (nur fuer die ausdruecklich
 * LIVE laufenden E2E-Tests, scripts/e2e-run.sh): CACHLY_NETZSPERRE=aus.
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');

const SCHLUESSEL = Symbol.for('cachly.netzsperre');

/** Ziele, die diesen Rechner nicht verlassen. */
const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|\[?::ffff:127(?:\.\d{1,3}){3}\]?|0\.0\.0\.0|\[?::\]?)$/i;

function zielAus(args) {
  const a = args[0];
  // net.connect() reicht ein vorbereitetes Feld [optionen, rueckruf] weiter.
  if (Array.isArray(a)) return zielAus([a[0]]);
  if (a && typeof a === 'object') {
    if (a.path) return null; // Unix-Socket / Named Pipe: bleibt auf dem Rechner
    return { host: String(a.host === undefined || a.host === null ? 'localhost' : a.host), port: a.port };
  }
  // connect(port[, host]) — eine reine Zeichenkette ohne Zahl ist ein Pfad
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(a) };
  }
  return null;
}

if (!globalThis[SCHLUESSEL] && process.env.CACHLY_NETZSPERRE !== 'aus') {
  const zustand = {
    /** Alle blockierten Versuche dieses Prozesses. */
    verstoesse: [],
    /** > 0 waehrend erwarte(): der Versuch ist Absicht (Waechter-Test). */
    tief: 0,
    /** Setzt der Testlauf: Name des laufenden Tests, fuer die Meldung. */
    testName: null,
    /** Fuehrt fn aus; blockierte Versuche darin gelten als beabsichtigt. */
    async erwarte(fn) {
      zustand.tief++;
      try { return await fn(); } finally { zustand.tief--; }
    },
  };
  globalThis[SCHLUESSEL] = zustand;

  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function netzsperre(...args) {
    const ziel = zielAus(args);
    if (!ziel || LOOPBACK.test(ziel.host)) return original.apply(this, args);

    const eintrag = {
      host: ziel.host,
      port: ziel.port === undefined ? null : Number(ziel.port),
      pid: process.pid,
      zeit: new Date().toISOString(),
      erwartet: zustand.tief > 0,
      test: typeof zustand.testName === 'function' ? zustand.testName() : '',
      befehl: String(process.argv[1] || '').split(/[\\/]/).slice(-2).join('/'),
    };
    zustand.verstoesse.push(eintrag);
    if (process.env.CACHLY_NETZSPERRE_LOG) {
      try { fs.appendFileSync(process.env.CACHLY_NETZSPERRE_LOG, JSON.stringify(eintrag) + '\n'); } catch { /* Zaehlwerk ist bestes Bemuehen */ }
    }
    const fehler = new Error(
      `Netzsperre im Test: Verbindung nach ${ziel.host}:${ziel.port} blockiert (nur Loopback erlaubt). ` +
      'Ein Test darf nie die Produktion erreichen — Attrappen-Server auf 127.0.0.1 benutzen.',
    );
    fehler.code = 'ECACHLYNETZSPERRE';
    // Wie eine verweigerte Verbindung: asynchron am Socket, nicht als Wurf.
    process.nextTick(() => this.destroy(fehler));
    return this;
  };
}
