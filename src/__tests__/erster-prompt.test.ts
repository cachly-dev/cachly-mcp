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
 *
 * ── Befund 13.10.2026, Folge 14.10. ─────────────────────────────────────────
 *
 * Die echte Probe mit 0.10.194 zeigte den ersten Block erst nach 58 s: den
 * Import machte der MCP-Server nach seinem npx-Kaltstart (~27 s). Seit dem
 * 14.10. importiert ein Nebenlauf des Hooks selbst ueber POST /learn
 * (startwissen-hook.ts). Der Auftrag an den Server kommt danach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOOK_BUENDEL, PLUGIN_HOOK_DIR } from '../ambient-hooks.js';
import { bestandPfad } from '../einblendung.js';
import { STARTER_CORPUS } from '../starter-corpus.js';

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
  /** Was ueber POST /learn ankam (der Start-Import des Hooks). */
  gelernt: Array<Record<string, unknown>>;
  /** true: Gelerntes erscheint im /export (wie bei der echten API). */
  lernenSichtbar: boolean;
  server: Server;
}

async function starteGegenstelle(): Promise<Gegenstelle> {
  const g = {
    anfragen: [] as Anfrage[],
    lektionen: [] as unknown[],
    sofortTest: 201 as number | 'haengt',
    verzoegerungMs: 0,
    instanz: `11111111-2222-3333-4444-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    gelernt: [] as Array<Record<string, unknown>>,
    lernenSichtbar: false,
  };
  const server = createServer((req, res) => {
    let rumpf = '';
    req.on('data', (d) => { rumpf += d; });
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
      if (req.method === 'POST' && pfad.endsWith('/learn')) {
        const lektion = JSON.parse(rumpf) as Record<string, unknown>;
        g.gelernt.push(lektion);
        if (g.lernenSichtbar) g.lektionen.push({ ...lektion, recall_count: 0 });
        return json(200, { ok: true, topic: lektion.topic });
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
/** Ein SessionStart mit Start-Import lief: afterEach wartet auf den Nebenlauf. */
let importLief: boolean;

beforeEach(async () => {
  importLief = false;
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
  // Der Nebenlauf des Start-Imports ist abgekoppelt. Er endet mit dem Auftrag;
  // erst danach Gegenstelle und Ordner abbauen, sonst schreibt er ins Leere.
  if (importLief && sofortTests().length > 0 && existsSync(credentials())) await warteAufAuftrag();
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
  // CACHLY_LERNEN=0 wie in vitest.config.ts: sonst faellt der Prompt je Lauf in 5 % in die
  // Kontrollgruppe (keine Einblendung) — die Instanz ist je Lauf eine andere.
  return {
    ...env, HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt, CLAUDE_PLUGIN_ROOT: pluginDir,
    CACHLY_API_URL: g.url, CACHLY_LERNEN: '0', ...extra,
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

const sitzungsStart = (extra: Record<string, string> = {}) => {
  if (extra.CACHLY_STARTWISSEN !== 'false') importLief = true;
  return lauf('SessionStart', { source: 'startup' }, extra);
};
const prompt = (extra: Record<string, string> = {}) => lauf('UserPromptSubmit', { prompt: FRAGE }, extra);
const sofortTests = () => g.anfragen.filter((a) => a.pfad === '/auth/instant-trial');
const credentials = () => join(heim, '.cachly', 'credentials.json');
const auftrag = () => join(heim, '.cachly', 'startwissen-auftrag.json');

/** Wartet, bis der Nebenlauf den Auftrag fuer den Server hinterlassen hat (sein letzter Schritt). */
async function warteAufAuftrag(fristMs = 15_000): Promise<Record<string, unknown>> {
  const ende = Date.now() + fristMs;
  while (Date.now() < ende) {
    try { return JSON.parse(readFileSync(auftrag(), 'utf8')) as Record<string, unknown>; } catch { /* noch nicht */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`kein Auftrag nach ${fristMs} ms`);
}

/** Macht den Projektordner zum Git-Repo mit diesen Commits (der aelteste zuerst). */
function gitProjekt(betreffs: string[]): void {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: projekt, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const b of betreffs) git('commit', '-q', '--allow-empty', '-m', b);
}

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

    // Der Start-Import laeuft in einem Nebenlauf des Hooks (seit 14.10.): der
    // Projektordner hat kein Git, also kommt der Startvorrat ueber /learn. Danach
    // hinterlaesst der Nebenlauf dem MCP-Server den Auftrag — mit `vomHook`, der
    // Server rechnet nur noch nach.
    const a = await warteAufAuftrag();
    expect(a.instanzId).toBe(g.instanz);
    expect(a.projekt).toBe(projekt);
    expect(a.vomHook).toEqual({ art: 'startvorrat', lektionen: STARTER_CORPUS.length });
    expect(g.gelernt.length).toBe(STARTER_CORPUS.length);
    expect(new Set(g.gelernt.map((l) => l.source))).toEqual(new Set(['starter']));
    // Jede /learn-Anfrage mit dem neuen Schluessel.
    const lernAnfragen = g.anfragen.filter((x) => x.pfad.endsWith('/learn'));
    expect(lernAnfragen.every((x) => x.auth === `Bearer ${SCHLUESSEL}`)).toBe(true);
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
  it('frisches Git-Projekt: der Hook importiert selbst, der erste Prompt hat den Block — ohne MCP-Server', async () => {
    // Die Probe vom 13.10. als Test: kein Werkzeugaufruf, kein MCP-Server.
    g.lernenSichtbar = true;
    gitProjekt([
      'Add project skeleton',
      'Fix deploy connection refused on node-1: fail2ban banned the deploy channel, ignoreip 10.8.0.0/24',
    ]);
    const start = Date.now();
    await sitzungsStart();
    const a = await warteAufAuftrag();
    const dauer = Date.now() - start;

    // Je Commit ein Thema, ueber /learn, als Import gekennzeichnet.
    expect(a.vomHook).toEqual({ art: 'git', lektionen: 2 });
    expect(g.gelernt.map((l) => l.source)).toEqual(['brain_from_git', 'brain_from_git']);
    expect(g.gelernt.every((l) => (l.tags as string[]).includes('brain_from_git'))).toBe(true);
    // Konto, Import und Bestand in wenigen Sekunden statt ~58 s.
    expect(dauer, `${dauer} ms`).toBeLessThan(10_000);

    // Der Nebenlauf hat den Bestand auf der Platte schon neu geschrieben: der
    // erste Prompt liest ihn dort und blendet ein.
    expect(JSON.parse(readFileSync(bestandPfad(g.instanz), 'utf8')).lessons).toHaveLength(2);
    const r = await prompt();
    expect(r.status).toBe(0);
    const kontext: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(kontext).toContain('fail2ban');
    expect(sofortTests().length).toBe(1);
  }, 30_000);

  it('Brain hat schon Lektionen (ein anderer war schneller): der Hook schickt nichts, der Server bekommt den gewoehnlichen Auftrag', async () => {
    g.lektionen = [LEKTION];
    await sitzungsStart();
    const a = await warteAufAuftrag();
    expect(g.gelernt).toEqual([]);
    expect(a.vomHook).toBeUndefined();
  });

  it('SessionStart, dann Import bringt Lektionen, dann der erste Prompt: Einblendung kommt', async () => {
    // t0: SessionStart legt das Konto an. /export ist leer; der Startvorrat des
    // Nebenlaufs bleibt hier unsichtbar (lernenSichtbar false).
    await sitzungsStart();
    await warteAufAuftrag();
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
