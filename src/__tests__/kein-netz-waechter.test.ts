/**
 * Waechter: ein Testlauf darf nie nach aussen — erst recht nicht an api.cachly.dev.
 *
 * Anlass (12.10.2026): rund 50 Hook-Laeufe ohne CACHLY_API_URL meldeten ihr
 * Ledger-Ereignis an die PRODUKTIONS-API (POST .../ambient-events, 401),
 * fail2ban sperrte die eigene IP fuer 6 Stunden. Die Sperre
 * (scripts/kein-netz-vorlauf.cjs, eingeschaltet in vitest.config.ts) macht das
 * fuer Tests und ihre Kindprozesse unmoeglich. Diese Datei haelt fest, dass die
 * Sperre WIRKT — eine Sperre, die nie geprueft wird, bewacht Luft.
 *
 * Die Versuche hier sind Absicht und laufen in `erwarte()`: sie stehen im
 * Zaehlwerk als "absichtlich" und machen den Lauf nicht rot. Jeder andere
 * Versuch laesst den Test rot werden, in dem er passiert (kein-netz.setup.ts),
 * und am Ende den ganzen Lauf (kein-netz.global.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Netzsperre {
  verstoesse: Array<{ host: string; port: number | null; erwartet: boolean }>;
  erwarte<T>(fn: () => Promise<T> | T): Promise<T>;
}
const sperre = (globalThis as Record<symbol, unknown>)[Symbol.for('cachly.netzsperre')] as Netzsperre | undefined;
const VORLAUF = resolve(__dirname, '..', '..', 'scripts', 'kein-netz-vorlauf.cjs');

describe('Netzsperre der Testumgebung', () => {
  // Sicherung der Sicherung: diese Datei versucht ABSICHTLICH, die Produktion zu
  // erreichen. Ist die Sperre nicht geladen (oder per CACHLY_NETZSPERRE=aus
  // abgeschaltet), darf KEIN Test hier laufen — sonst traefe der Waechter selbst die Produktion.
  beforeAll(() => {
    expect(process.env.CACHLY_NETZSPERRE, 'Waechter-Test mit abgeschalteter Netzsperre').not.toBe('aus');
    expect(sperre, 'kein-netz.setup.ts hat die Sperre nicht geladen').toBeDefined();
  });

  it('ist eingeschaltet (sonst ist jede weitere Zusicherung leer)', () => {
    expect(sperre).toBeDefined();
  });

  it('die Update-Abfrage bei npm ist im Test aus (sonst haengt Hintergrund-Netz am zufaellig laufenden Test)', () => {
    expect(process.env.CACHLY_UPDATE_CHECK).toBe('false');
  });

  it('fetch an api.cachly.dev scheitert und wird gezaehlt', async () => {
    const vorher = sperre!.verstoesse.length;
    await sperre!.erwarte(async () => {
      await expect(fetch('https://api.cachly.dev/api/v1/instances/x/ambient-events', {
        method: 'POST', body: '{}', signal: AbortSignal.timeout(3000),
      })).rejects.toThrow();
    });
    const neu = sperre!.verstoesse.slice(vorher);
    expect(neu.length).toBeGreaterThanOrEqual(1);
    expect(neu.every((v) => v.erwartet)).toBe(true);
    expect(neu.some((v) => v.host === 'api.cachly.dev' && v.port === 443)).toBe(true);
  });

  it('auch ein Produktcode, der den Fehler verschluckt, hinterlaesst die Spur', async () => {
    const vorher = sperre!.verstoesse.length;
    await sperre!.erwarte(async () => {
      // so schreibt ambient-ledger.ts: .then(ok, () => undefined)
      await fetch('http://api.cachly.dev/x', { signal: AbortSignal.timeout(3000) }).then(() => undefined, () => undefined);
    });
    expect(sperre!.verstoesse.length).toBeGreaterThan(vorher);
  });

  it('https.request und net.connect nach aussen scheitern mit dem Sperr-Code', async () => {
    await sperre!.erwarte(async () => {
      const viaHttps = await new Promise<string>((ok) => {
        const r = https.request('https://registry.npmjs.org/', (res) => { res.resume(); ok('verbunden'); });
        r.on('error', (e: NodeJS.ErrnoException) => ok(String(e.code)));
        r.end();
      });
      expect(viaHttps).toBe('ECACHLYNETZSPERRE');
      const viaNet = await new Promise<string>((ok) => {
        const s = net.connect({ host: 'example.com', port: 80 });
        s.on('connect', () => { s.destroy(); ok('verbunden'); });
        s.on('error', (e: NodeJS.ErrnoException) => ok(String(e.code)));
      });
      expect(viaNet).toBe('ECACHLYNETZSPERRE');
      const viaZahl = await new Promise<string>((ok) => {
        const s = net.connect(443, 'api.cachly.dev');
        s.on('connect', () => { s.destroy(); ok('verbunden'); });
        s.on('error', (e: NodeJS.ErrnoException) => ok(String(e.code)));
      });
      expect(viaZahl).toBe('ECACHLYNETZSPERRE');
    });
  });

  it('Loopback bleibt offen: ein Attrappen-Server auf 127.0.0.1 antwortet (so laufen die bestehenden Tests)', async () => {
    const vorher = sperre!.verstoesse.length;
    const server = createServer((_q, a) => { a.end('ok'); });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      expect(await (await fetch(url)).text()).toBe('ok');
      expect(await (await fetch(url.replace('127.0.0.1', 'localhost'))).text()).toBe('ok');
    } finally {
      server.close();
    }
    expect(sperre!.verstoesse.length).toBe(vorher); // nichts gezaehlt
  });

  it('eine tote Loopback-Adresse scheitert als normale Verweigerung, nicht als Sperre', async () => {
    const vorher = sperre!.verstoesse.length;
    await expect(fetch('http://127.0.0.1:9/api/v1/health', { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
    expect(sperre!.verstoesse.length).toBe(vorher);
  });

  describe('Kindprozesse (Hooks, CLI) erben die Sperre', () => {
    it('ein Kindprozess ohne CACHLY_API_URL erreicht api.cachly.dev nicht, und das Zaehlwerk haelt es fest', () => {
      const dir = mkdtempSync(join(tmpdir(), 'kein-netz-'));
      const log = join(dir, 'zaehlwerk.log');
      try {
        // Genau der Fehlerfall vom 12.10.: eigener Prozess, kein CACHLY_API_URL, Produktcode verschluckt den Fehler.
        const ausgabe = execFileSync(process.execPath, [
          '-e',
          "if(!globalThis[Symbol.for('cachly.netzsperre')]){console.log('OHNE_SPERRE');process.exit(0)}" +
          "fetch('https://api.cachly.dev/api/v1/instances/x/ambient-events',{method:'POST',body:'{}'}).then(()=>console.log('ERREICHT'),(e)=>console.log('GESCHEITERT'))",
        ], {
          env: { ...process.env, NODE_OPTIONS: `--require "${VORLAUF.replaceAll('\\', '/')}"`, CACHLY_NETZSPERRE_LOG: log },
          encoding: 'utf8',
          timeout: 20000,
        });
        expect(ausgabe.trim()).toBe('GESCHEITERT');
        const zeilen = readFileSync(log, 'utf8').trim().split('\n').map((z) => JSON.parse(z) as { host: string; erwartet: boolean });
        expect(zeilen).toHaveLength(1);
        expect(zeilen[0]).toMatchObject({ host: 'api.cachly.dev', erwartet: false });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('Gegenprobe: ohne den Vorlauf wuerde der Versuch rausgehen (nur bis zur Sperre geprueft, auf Loopback-Attrappe)', () => {
      // Beweist, dass der Versuch oben an der SPERRE scheitert und nicht an etwas anderem:
      // dieselbe Zeile gegen einen lokalen Server verbindet.
      const dir = mkdtempSync(join(tmpdir(), 'kein-netz-'));
      const log = join(dir, 'zaehlwerk.log');
      try {
        const ausgabe = execFileSync(process.execPath, [
          '-e',
          `const s=require('node:http').createServer((q,a)=>a.end('ok')).listen(0,'127.0.0.1',async()=>{` +
          `const r=await fetch('http://127.0.0.1:'+s.address().port+'/');console.log(await r.text());s.close();});`,
        ], {
          env: { ...process.env, NODE_OPTIONS: `--require "${VORLAUF.replaceAll('\\', '/')}"`, CACHLY_NETZSPERRE_LOG: log },
          encoding: 'utf8',
          timeout: 20000,
        });
        expect(ausgabe.trim()).toBe('ok');
        expect(() => readFileSync(log, 'utf8')).toThrow(); // nichts gezaehlt, keine Datei
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
