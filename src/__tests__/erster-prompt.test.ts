/**
 * Frische Plugin-Installation: die Einblendung beginnt im ERSTEN Prompt.
 *
 * ── Befund 12.10.2026 (Probe mit dem echten Plugin) ─────────────────────────
 *
 * Plugin cachly-brain 0.10.184, echte Claude-Code-CLI 2.1.292, abgeschotteter
 * Heimordner. Beim ersten Prompt (SessionStart + UserPromptSubmit) lieferten
 * beide Hooks 0 Zeichen. Das Konto entstand erst im MCP-Server beim ersten
 * Werkzeugaufruf. Ruft das Modell kein Werkzeug, bekam der Nutzer nie eine
 * Einblendung, und der Start-Import begann nie.
 *
 * Diese Tests starten das ECHTE Buendel (hooks/cachly-ambient-einblendung.mjs)
 * als Prozess gegen eine nachgebaute Gegenstelle. Sie waren gegen den Stand
 * vom 12.10. rot (Gegenprobe im PR beschrieben).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOOK_BUENDEL, PLUGIN_HOOK_DIR } from '../ambient-hooks.js';
import { bestandPfad } from '../einblendung.js';

const SDK = resolve(__dirname, '..', '..');
const BUENDEL = join(SDK, PLUGIN_HOOK_DIR, HOOK_BUENDEL);

const SCHLUESSEL = 'cky_trial_erstprompt00000000000000000';
const FRAGE = 'Warum meldet der Deploy auf node-1 connection refused, obwohl fail2ban laeuft?';
const LEKTION = {
  topic: 'betrieb:fail2ban-bannt-deploy-kanal',
  what_worked: 'fail2ban auf node-1 bannte 10.8.0.6 und der Deploy meldete connection refused. '
    + 'Abhilfe: ignoreip 10.8.0.0/24 in jail.local eintragen und fail2ban neu starten.',
  outcome: 'success',
  severity: 'critical',
  recall_count: 3,
};

interface Anfrage { methode: string; pfad: string; ua: string; auth: string }

interface Gegenstelle {
  url: string;
  anfragen: Anfrage[];
  /** Was /export liefert: das Brain waechst, solange der Start-Import laeuft. */
  lektionen: unknown[];
  /** 201 = Konto anlegen; 'haengt' = nie antworten; sonst dieser Status. */
  sofortTest: number | 'haengt';
  verzoegerungMs: number;
  instanz: string;
  server: Server;
}

async function starteGegenstelle(): Promise<Gegenstelle> {
  const g = {
    anfragen: [] as Anfrage[],
    lektionen: [] as unknown[],
    sofortTest: 201 as number | 'haengt',
    verzoegerungMs: 0,
    instanz: `11111111-2222-3333-4444-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
  };
  const server = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      g.anfragen.push({
        methode: req.method ?? '', pfad,
        ua: String(req.headers['user-agent'] ?? ''), auth: String(req.headers.authorization ?? ''),
      });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && pfad === '/auth/instant-trial') {
        if (g.sofortTest === 'haengt') return; // nie antworten
        const status = g.sofortTest;
        setTimeout(() => {
          if (status !== 201) return json(status, { error: 'abgelehnt' });
          return json(201, { api_key: SCHLUESSEL, instance_id: g.instanz, trial: true, trial_ends_at: '2026-10-26T12:00:00Z' });
        }, g.verzoegerungMs);
        return;
      }
      if (pfad.endsWith('/export')) {
        return json(200, { lessons: g.lektionen.map((l) => JSON.stringify(l)) });
      }
      return json(503, {}); // Leser aus: lokale Reihenfolge
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(g, { url, server });
}

let g: Gegenstelle;
let tmp: string;
let heim: string;
let projekt: string;
let pluginDir: string;

beforeEach(async () => {
  g = await starteGegenstelle();
  tmp = mkdtempSync(join(tmpdir(), 'cachly-erstprompt-'));
  heim = join(tmp, 'heim');
  projekt = join(tmp, 'projekt');
  pluginDir = join(tmp, 'plugin');
  mkdirSync(heim, { recursive: true });
  mkdirSync(projekt, { recursive: true });
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'cachly-brain', version: '9.9.9' }));
});

afterEach(async () => {
  g.server.closeAllConnections();
  await new Promise<void>((r) => g.server.close(() => r()));
  rmSync(bestandPfad(g.instanz), { force: true });
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function umfeld(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  // Nur was das Betriebssystem zum Starten braucht — NICHT die echte Umgebung
  // mit einem echten CACHLY_JWT.
  for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return {
    ...env, HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt, CLAUDE_PLUGIN_ROOT: pluginDir,
    CACHLY_API_URL: g.url, ...extra,
  };
}

function lauf(ereignis: string, payload: object, extra: Record<string, string> = {}, args: string[] = ['--plugin']) {
  return new Promise<{ status: number | null; stdout: string; ms: number }>((fertig) => {
    const start = Date.now();
    const kind = spawn(process.execPath, [BUENDEL, ereignis, ...args], { env: umfeld(extra), cwd: projekt });
    let stdout = '';
    kind.stdout.on('data', (d) => { stdout += d; });
    kind.on('close', (status) => fertig({ status, stdout, ms: Date.now() - start }));
    kind.stdin.end(JSON.stringify({ hook_event_name: ereignis, session_id: 's1', cwd: projekt, ...payload }));
  });
}

const sitzungsStart = (extra: Record<string, string> = {}) => lauf('SessionStart', { source: 'startup' }, extra);
const prompt = (extra: Record<string, string> = {}) => lauf('UserPromptSubmit', { prompt: FRAGE }, extra);
const sofortTests = () => g.anfragen.filter((a) => a.pfad === '/auth/instant-trial');
const credentials = () => join(heim, '.cachly', 'credentials.json');
const auftrag = () => join(heim, '.cachly', 'startwissen-auftrag.json');

describe('SessionStart legt das Konto an — ohne dass ein Werkzeug gerufen wird', () => {
  it('ohne Schluessel: genau ein Konto, Schluessel + Instanz abgelegt, Hinweis fuer den Assistenten, schnell', async () => {
    const r = await sitzungsStart();

    expect(r.status).toBe(0);
    expect(sofortTests().length, 'Sofort-Test-Anfragen').toBe(1);
    // Herkunft im ersten Feld des User-Agent, Nummer aus dem Plugin-Ordner.
    expect(sofortTests()[0]!.ua).toBe('cachly-claude-code-plugin/9.9.9');

    const cred = JSON.parse(readFileSync(credentials(), 'utf8'));
    expect(cred).toEqual({ apiKey: SCHLUESSEL, instanceId: g.instanz });
    expect(existsSync(join(heim, '.cachly', 'anlegen.lock'))).toBe(false);

    // Der Assistent bekommt den Hinweis (einmal), damit der Nutzer ihn erfaehrt.
    const kontext: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(kontext).toContain('test Brain was created');
    expect(kontext.match(/test Brain was created/g)?.length).toBe(1);
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');

    // Der Hook hat das Zeitbudget nicht angerührt: Sofort-Test + Bestand in unter 5 s.
    expect(r.ms, `${r.ms} ms`).toBeLessThan(5000);

    // Der Start-Import laeuft im MCP-Server (er hat die Brain-Verbindung): der Hook
    // hinterlaesst den Auftrag mit Instanz und Projektordner.
    const a = JSON.parse(readFileSync(auftrag(), 'utf8'));
    expect(a.instanzId).toBe(g.instanz);
    expect(a.projekt).toBe(projekt);
  });

  it('zwei Starts gleichzeitig (zwei Sitzungen): ein Konto, beide enden still oder mit Hinweis', async () => {
    g.verzoegerungMs = 400; // die Anfrage laeuft noch, wenn der zweite Start kommt
    const [a, b] = await Promise.all([sitzungsStart(), sitzungsStart()]);

    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(sofortTests().length, 'zweites Konto angelegt').toBe(1);
    // Genau einer hat angelegt und sagt es; der andere findet den Schluessel vor.
    const mitHinweis = [a, b].filter((r) => r.stdout.includes('test Brain was created'));
    expect(mitHinweis.length).toBe(1);
    expect(JSON.parse(readFileSync(credentials(), 'utf8')).apiKey).toBe(SCHLUESSEL);
  });

  it('mit Schluessel: kein Konto, kein Hinweis, kein Auftrag', async () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(credentials(), JSON.stringify({ apiKey: 'cky_vorhanden', instanceId: g.instanz }));
    const r = await sitzungsStart();

    expect(sofortTests()).toEqual([]);
    expect(r.stdout).not.toContain('test Brain was created');
    expect(existsSync(auftrag())).toBe(false);
  });

  it('Schluessel aus der Plugin-Option zaehlt wie jeder andere: kein Konto', async () => {
    await sitzungsStart({ CLAUDE_PLUGIN_OPTION_API_KEY: 'cky_option', CLAUDE_PLUGIN_OPTION_INSTANCE_ID: g.instanz });
    expect(sofortTests()).toEqual([]);
  });

  it('nur UserPromptSubmit und Stop ohne Schluessel: kein Konto (nur SessionStart legt an)', async () => {
    await prompt();
    await lauf('Stop', { last_assistant_message: 'x' });
    expect(g.anfragen).toEqual([]);
    expect(existsSync(credentials())).toBe(false);
  });

  it('ohne --plugin (Projekt-Hook) legt der Hook kein Konto an: die Installation ist dort nicht ausdruecklich', async () => {
    await lauf('SessionStart', { source: 'startup' }, {}, []);
    expect(sofortTests()).toEqual([]);
  });

  it('eine Instanz in UUID-Form ohne Schluessel zeigt auf ein bestehendes Brain: kein zweites Konto', async () => {
    await sitzungsStart({ CACHLY_BRAIN_INSTANCE_ID: '99999999-8888-7777-6666-555555555555' });
    expect(sofortTests()).toEqual([]);
  });

  it('ein erfundener Wert wie "default" zaehlt nicht als Brain (wie im MCP-Server)', async () => {
    await sitzungsStart({ CACHLY_BRAIN_INSTANCE_ID: 'default' });
    expect(sofortTests().length).toBe(1);
  });

  it('CACHLY_STARTWISSEN=false: Konto ja, Auftrag fuer den Import nein', async () => {
    await sitzungsStart({ CACHLY_STARTWISSEN: 'false' });
    expect(sofortTests().length).toBe(1);
    expect(existsSync(auftrag())).toBe(false);
  });

  it('Gegenstelle lehnt ab (429): still, Exit 0, kein Schluessel — und beim naechsten SessionStart kein neuer Versuch', async () => {
    g.sofortTest = 429;
    const erst = await sitzungsStart();
    expect(erst.status).toBe(0);
    expect(erst.stdout).toBe('');
    expect(existsSync(credentials())).toBe(false);

    // SessionStart feuert auch bei resume/clear/compact: die Grenze liegt bei 5 Versuchen je Stunde.
    await sitzungsStart();
    expect(sofortTests().length).toBe(1);
  });

  it('haengende Gegenstelle: der Hook endet nach hoechstens ~5 s Kontoarbeit, still, Exit 0', async () => {
    g.sofortTest = 'haengt';
    const r = await sitzungsStart();

    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    // Frist fuer das Konto: 5 s. Dazu Start des Prozesses; weit unter den 30 s des Hooks.
    expect(r.ms, `${r.ms} ms`).toBeLessThan(8000);
    expect(r.ms, `${r.ms} ms`).toBeGreaterThan(4500);
    expect(existsSync(join(heim, '.cachly', 'anlegen.lock'))).toBe(false);
  }, 20_000);
});

describe('Der erste Prompt nach der Installation', () => {
  it('SessionStart, dann Import bringt Lektionen, dann der erste Prompt: Einblendung kommt', async () => {
    // t0: SessionStart legt das Konto an. Die Instanz startet noch, /export ist leer.
    await sitzungsStart();
    const bestand = bestandPfad(g.instanz);
    expect(existsSync(bestand)).toBe(true);
    expect(JSON.parse(readFileSync(bestand, 'utf8')).lessons).toEqual([]);

    // t0 + 20 s: der Start-Import hat Lektionen geschrieben. Der Bestand auf der
    // Platte ist 20 s alt — bis zum 12.10. galt er zehn Minuten als frisch.
    g.lektionen = [LEKTION];
    const roh = JSON.parse(readFileSync(bestand, 'utf8'));
    writeFileSync(bestand, JSON.stringify({ ...roh, at: roh.at - 20_000, seit: roh.seit - 20_000 }));

    const r = await prompt();
    expect(r.status).toBe(0);
    const kontext: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(kontext).toContain('fail2ban');
    // Der Prompt hat nur gewartet, was er musste: ein Abruf, kein zweites Konto.
    expect(sofortTests().length).toBe(1);
  });
});
