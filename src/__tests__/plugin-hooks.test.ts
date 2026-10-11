/**
 * Das Hook-Buendel: eine Datei, kein npx — fuer das Plugin und die Projekt-Hooks.
 *
 * ── Warum (11.10.2026) ──────────────────────────────────────────────────────
 *
 * Bis heute rief jeder Hook `npx @cachly-dev/mcp-server@latest ambient-recall`.
 * Gemessen: 7,7 s je Prompt warm, 17,1 s kalt, bei einer Grenze von 10 s. Jetzt
 * liegt unter sdk/mcp/hooks/ ein Buendel (esbuild aus src/ambient-hook-start.ts)
 * und die hooks.json des Plugins. Dieser Waechter prueft:
 *
 *   1. Die eingecheckten Dateien sind byte-gleich mit dem, was die Quelle heute
 *      erzeugt. Abhilfe bei Rot: cd sdk/mcp && npm run plugin-hooks:write
 *   2. hooks.json zeigt auf das Buendel, das Buendel landet im Spiegel und im
 *      npm-Paket.
 *   3. Das echte Buendel laeuft: ohne Schluessel still und schnell, mit
 *      Schluessel gegen einen Testserver mit Einblendung, Stop lernt ueber
 *      REST, und das Plugin tritt zurueck, wenn das Projekt die Hooks hat.
 *   4. installAmbientHooks kopiert das Buendel, und der Projekt-Hook laeuft
 *      damit ohne npx.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { erzeugeDateien } from '../../scripts/plugin-hooks-schreiben.mjs';
import {
  HOOK_BUENDEL,
  PLUGIN_HOOK_DIR,
  PLUGIN_HOOK_EVENTS,
  installAmbientHooks,
} from '../ambient-hooks.js';
import { bestandPfad } from '../einblendung.js';
import { stopLernanfrage, stopObservation } from '../ambient-cli.js';
import { ckgSlug, extractProblemConcept } from '../ckg.js';

const SDK = resolve(__dirname, '..', '..');
const REPO = resolve(SDK, '..', '..');
const BUENDEL = join(SDK, PLUGIN_HOOK_DIR, HOOK_BUENDEL);

describe('Hook-Buendel — Erzeugnis und Quelle', () => {
  it('jede erzeugte Datei liegt eingecheckt und ist byte-gleich mit der Quelle', async () => {
    const soll = await erzeugeDateien();
    for (const [pfad, inhalt] of Object.entries(soll)) {
      const ziel = join(SDK, pfad);
      expect(existsSync(ziel), `${pfad} fehlt — cd sdk/mcp && npm run plugin-hooks:write`).toBe(true);
      // Nicht nur die Laenge: eine geaenderte Zahl bei gleicher Laenge waere sonst unsichtbar.
      expect(readFileSync(ziel, 'utf8') === inhalt, `${pfad} veraltet — cd sdk/mcp && npm run plugin-hooks:write`).toBe(true);
    }
    const vorhanden = readdirSync(join(SDK, PLUGIN_HOOK_DIR)).map((n) => `${PLUGIN_HOOK_DIR}/${n}`).sort();
    expect(vorhanden).toEqual(Object.keys(soll).sort());
  });

  it('das Buendel braucht kein node_modules — nur Node-Bordmittel', () => {
    const inhalt = readFileSync(BUENDEL, 'utf8');
    const importe = [...inhalt.matchAll(/(?:^|[;\s])import\s*(?:[^"';]*?from\s*)?["']([^"']+)["']/g)].map((m) => m[1]);
    expect(importe.length).toBeGreaterThan(0);
    for (const i of importe) expect(i, i).toMatch(/^node:/);
    expect(inhalt).not.toMatch(/\brequire\(/);
  });

  it('das Buendel ist kleiner als 1 MB', () => {
    expect(statSync(BUENDEL).size).toBeLessThan(1024 * 1024);
  });

  it('das Buendel kommt ins npm-Paket — sonst findet installAmbientHooks es nicht', () => {
    const paket = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as { files: string[] };
    expect(paket.files).toContain(`${PLUGIN_HOOK_DIR}/${HOOK_BUENDEL}`);
  });

  it('Sofort-Test, Browser-Anmeldung und Auto-Provision legen die Instanz neben den Schluessel', () => {
    // Alle drei laufen durch persistInstanceIdToConfig (zugang.ts-Ablage, Geraetefluss, autoProvision).
    const quelle = readFileSync(join(SDK, 'src', 'index.ts'), 'utf8');
    const anfang = quelle.indexOf('async function persistInstanceIdToConfig(');
    expect(anfang).toBeGreaterThan(0);
    expect(quelle.slice(anfang, anfang + 400)).toContain('saveInstanceId(instanceId, { apiKey: JWT })');
  });

  it('der Spiegel nach cachly-mcp nimmt hooks/ mit', () => {
    const spiegel = readFileSync(join(REPO, '.github', 'workflows', 'mirror-mcp.yml'), 'utf8');
    expect(spiegel).toMatch(/rsync[\s\S]*sdk\/mcp\/ \/tmp\/mirror\//);
    expect(spiegel).not.toMatch(/--exclude='?hooks/);
  });
});

describe('Plugin — hooks.json', () => {
  const hooksJson = JSON.parse(readFileSync(join(SDK, PLUGIN_HOOK_DIR, 'hooks.json'), 'utf8')) as {
    hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
  };

  it('liefert genau SessionStart, UserPromptSubmit und Stop', () => {
    expect(Object.keys(hooksJson.hooks).sort()).toEqual([...PLUGIN_HOOK_EVENTS].sort());
  });

  it('jeder Befehl ruft das Buendel direkt mit node, dem Ereignis und --plugin — kein npx', () => {
    for (const [ereignis, gruppen] of Object.entries(hooksJson.hooks)) {
      for (const h of gruppen.flatMap((g) => g.hooks)) {
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)" (\w+) --plugin$/.exec(h.command);
        expect(m, h.command).not.toBeNull();
        expect(existsSync(join(SDK, m![1])), m![1]).toBe(true);
        expect(m![2]).toBe(ereignis);
        expect(h.command).not.toContain('npx');
      }
    }
  });

  it('jeder Hook hat ein Zeitlimit; vor dem Prompt hoechstens 10 s', () => {
    for (const [ereignis, gruppen] of Object.entries(hooksJson.hooks)) {
      for (const h of gruppen.flatMap((g) => g.hooks)) {
        expect(h.timeout, ereignis).toBeGreaterThan(0);
        if (ereignis === 'UserPromptSubmit') expect(h.timeout).toBeLessThanOrEqual(10);
      }
    }
  });

  it('kein ${user_config...} im Befehl — sonst laeuft der Hook bei leerer Option still nie (siehe .claude-plugin/README.md)', () => {
    expect(JSON.stringify(hooksJson)).not.toContain('user_config');
  });

  it('plugin.json nennt hooks nicht noch einmal — hooks/hooks.json laedt Claude Code von selbst', () => {
    const manifest = JSON.parse(readFileSync(join(SDK, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(manifest.hooks).toBeUndefined();
  });
});

// ── Laufzeit: das echte Buendel gegen einen Testserver ───────────────────────

interface Anfrage { methode: string; pfad: string; body: string; auth: string }

let server: Server;
let apiUrl: string;
let anfragen: Anfrage[] = [];

const LEKTION = {
  topic: 'betrieb:fail2ban-bannt-deploy-kanal',
  what_worked: 'fail2ban auf node-1 bannte 10.8.0.6 und der Deploy meldete connection refused. '
    + 'Abhilfe: ignoreip 10.8.0.0/24 in jail.local eintragen und fail2ban neu starten.',
  outcome: 'success',
  severity: 'critical',
  recall_count: 3,
};
const FRAGE = 'Warum meldet der Deploy auf node-1 connection refused, obwohl fail2ban laeuft?';
const STOP_NACHRICHT = 'Fixed the deploy failure on node-1: fail2ban had banned the runner address, '
  + 'added ignoreip 10.8.0.0/24 and restarted fail2ban, the deploy is green again.';

describe('Stop-Lektion: dieselbe fixes-Kante wie auto_learn_session', () => {
  // v4 lernte ueber auto_learn_session (handlers/brain.ts) und legte dort die
  // fixes-Kante an. Das Buendel lernt ueber POST /learn; die Go-API legt die
  // Kante jetzt nach derselben Regel an (api/internal/handler/lesson_write.go,
  // schreibeKausalKante). Gegenstueck mit DEMSELBEN Literal:
  // api/internal/handler/lesson_kausal_test.go.
  it('Thema, Problem und Kante stimmen mit der MCP-Regel ueberein', () => {
    const obs = stopObservation({ hook_event_name: 'Stop', last_assistant_message: STOP_NACHRICHT })!;
    const req = stopLernanfrage(obs);
    // auto_learn_session: Knoten aus dem Thema, Problem aus obs.details.
    const kante = `cachly:ckg:edge:${ckgSlug(req.topic)}:fixes:${ckgSlug(`problem:${extractProblemConcept(obs.details)}`)}`;
    expect(kante).toBe('cachly:ckg:edge:auto:fixed-the-deploy-failure:fixes:problem:fixed-deploy');
    // Die Go-Regel greift ueber den Tag und liest das Problem aus context.
    expect(req.tags).toContain('auto-learned');
    expect(req.context).toBe(obs.details);
  });
});

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      anfragen.push({ methode: req.method ?? '', pfad: req.url ?? '', body, auth: String(req.headers.authorization ?? '') });
      if (req.url?.endsWith('/export')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lessons: [JSON.stringify(LEKTION)] }));
        return;
      }
      if (req.url?.endsWith('/learn') || req.url?.endsWith('/ambient-events')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(503); // Leser aus: lokale Reihenfolge
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let tmp: string;
let heim: string;
let projekt: string;
let instanz: string;

beforeEach(() => {
  anfragen = [];
  tmp = mkdtempSync(join(tmpdir(), 'cachly-hook-buendel-'));
  heim = join(tmp, 'heim');
  projekt = join(tmp, 'projekt');
  mkdirSync(heim, { recursive: true });
  mkdirSync(projekt, { recursive: true });
  // Eigene Instanz je Test: der Bestand liegt je Instanz im Temp-Ordner.
  instanz = `inst-test-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(bestandPfad(instanz), { force: true });
});

function umfeld(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // Nur was das Betriebssystem zum Starten braucht — NICHT die echte Umgebung
  // mit einem echten CACHLY_JWT.
  for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'TMP']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return { ...env, HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt, CACHLY_API_URL: apiUrl, ...extra };
}

function lauf(skript: string, args: string[], payload: object, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; ms: number }>((fertig) => {
    const start = Date.now();
    const kind = spawn(process.execPath, [skript, ...args], { env: umfeld(extra), cwd: projekt });
    let stdout = '';
    kind.stdout.on('data', (d) => { stdout += d; });
    kind.on('close', (status) => fertig({ status, stdout, ms: Date.now() - start }));
    kind.stdin.end(JSON.stringify(payload));
  });
}

function schreibeJson(pfad: string, inhalt: unknown) {
  mkdirSync(resolve(pfad, '..'), { recursive: true });
  writeFileSync(pfad, JSON.stringify(inhalt, null, 2), 'utf8');
}

const prompt = (e = 'UserPromptSubmit') => ({ hook_event_name: e, prompt: FRAGE, session_id: 's1', cwd: '/repo' });

describe('Plugin-Lauf — das echte Buendel', () => {
  it('ohne Schluessel: Exit 0, keine Ausgabe, keine Anfrage — und schnell', async () => {
    for (const e of PLUGIN_HOOK_EVENTS) {
      const r = await lauf(BUENDEL, [e, '--plugin'], prompt(e));
      expect(r.status, e).toBe(0);
      expect(r.stdout, e).toBe('');
      expect(r.ms, `${e}: ${r.ms} ms`).toBeLessThan(5000);
    }
    expect(anfragen).toEqual([]);
  });

  it('nach dem Sofort-Test: Schluessel UND Instanz aus ~/.cachly/credentials.json — Einblendung kommt', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_aus_datei', instanceId: instanz });
    const r = await lauf(BUENDEL, ['UserPromptSubmit', '--plugin'], prompt());
    expect(r.status).toBe(0);
    const ctx: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('fail2ban');
    const exp = anfragen.find((a) => a.pfad.endsWith('/export'))!;
    expect(exp.pfad).toBe(`/api/v1/instances/${instanz}/export`);
    expect(exp.auth).toBe('Bearer cky_aus_datei');
  });

  it('alte Datei ohne Instanz: die Instanz kommt aus ~/.claude/mcp.json', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_alt' });
    schreibeJson(join(heim, '.claude', 'mcp.json'), { mcpServers: { cachly: { env: { CACHLY_BRAIN_INSTANCE_ID: instanz } } } });
    const r = await lauf(BUENDEL, ['UserPromptSubmit', '--plugin'], prompt());
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('fail2ban');
  });

  it('Plugin-Optionen gelten zuerst; Platzhalter zaehlen als nichts', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_aus_datei', instanceId: 'inst-falsch' });
    await lauf(BUENDEL, ['SessionStart', '--plugin'], { hook_event_name: 'SessionStart', source: 'startup' }, {
      CLAUDE_PLUGIN_OPTION_API_KEY: 'cky_option',
      CLAUDE_PLUGIN_OPTION_INSTANCE_ID: instanz,
      CACHLY_JWT: '${user_config.api_key}',
    });
    const exp = anfragen.find((a) => a.pfad.endsWith('/export'))!;
    expect(exp.pfad).toBe(`/api/v1/instances/${instanz}/export`);
    expect(exp.auth).toBe('Bearer cky_option');
  });

  it('Stop mit klarer Behebung lernt ueber REST /learn — ohne npx, ohne Ausgabe', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
    const r = await lauf(BUENDEL, ['Stop', '--plugin'], { hook_event_name: 'Stop', last_assistant_message: STOP_NACHRICHT });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    const lernen = anfragen.find((a) => a.pfad.endsWith('/learn'))!;
    expect(lernen.pfad).toBe(`/api/v1/instances/${instanz}/learn`);
    const body = JSON.parse(lernen.body);
    expect(body.topic).toBe('auto:fixed-the-deploy-failure');
    expect(body.outcome).toBe('success');
    expect(body.source).toBe('ambient-stop');
  });

  it('nie doppelt: hat das Projekt die Hooks von init/setup/autopilot, tritt das Plugin zurueck', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
    await installAmbientHooks(projekt, 'inst-projekt');
    for (const e of PLUGIN_HOOK_EVENTS) {
      const r = await lauf(BUENDEL, [e, '--plugin'], prompt(e));
      expect(r.stdout, `${e}: Plugin lief trotz Projekt-Hook`).toBe('');
    }
    expect(anfragen).toEqual([]);
  });

  it('je Ereignis: verdrahtet das Projekt nur SessionStart, laeuft UserPromptSubmit aus dem Plugin', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
    schreibeJson(join(projekt, '.claude', 'settings.json'), {
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node "/p/.claude/hooks/cachly-ambient-session-start.mjs"' }] }] },
    });
    expect((await lauf(BUENDEL, ['SessionStart', '--plugin'], prompt('SessionStart'))).stdout).toBe('');
    expect((await lauf(BUENDEL, ['UserPromptSubmit', '--plugin'], prompt())).stdout).toContain('fail2ban');
  });

  it('haengt der Server, endet der Lauf an der Gesamtfrist — still, Exit 0', async () => {
    // Ein Server, der die Verbindung annimmt und nie antwortet.
    const stumm = createServer(() => { /* nie antworten */ });
    await new Promise<void>((r) => stumm.listen(0, '127.0.0.1', () => r()));
    try {
      schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
      const r = await lauf(BUENDEL, ['UserPromptSubmit', '--plugin'], prompt(), {
        CACHLY_API_URL: `http://127.0.0.1:${(stumm.address() as AddressInfo).port}`,
        CACHLY_HOOK_FRIST_MS: '1500',
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      // Ohne Frist endete der Lauf erst am Abruflimit (5 s).
      expect(r.ms, `${r.ms} ms`).toBeLessThan(4000);
    } finally {
      stumm.closeAllConnections();
      await new Promise<void>((r) => stumm.close(() => r()));
    }
  });

  it('ohne --plugin (Projekt-Lauf) gibt es keinen Ruecktritt — der Projekt-Hook IST der Hook', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
    await installAmbientHooks(projekt, instanz);
    const r = await lauf(BUENDEL, ['UserPromptSubmit'], prompt());
    expect(r.stdout).toContain('fail2ban');
  });
});

describe('Projekt-Lauf — installAmbientHooks kopiert das Buendel, kein npx', () => {
  it('der installierte Hook laedt das Buendel daneben und blendet ein', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installAmbientHooks(projekt, instanz);
    expect(readFileSync(a.bundlePath, 'utf8')).toBe(readFileSync(BUENDEL, 'utf8'));
    const r = await lauf(a.promptSubmitPath, [], prompt());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('fail2ban');
    // Die Instanz kommt aus dem Skript (vom Nutzer fuer dieses Projekt gewaehlt).
    expect(anfragen.find((x) => x.pfad.endsWith('/export'))!.pfad).toBe(`/api/v1/instances/${instanz}/export`);
  });

  it('ein v4-Skript (npx) wird beim naechsten Lauf ersetzt; danach unveraendert', async () => {
    const dir = join(projekt, '.claude', 'hooks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cachly-ambient-prompt-submit.mjs'),
      "// cachly Ambient Recall — UserPromptSubmit v4\nspawn('npx @cachly-dev/mcp-server@latest ambient-recall')\n");
    const erst = await installAmbientHooks(projekt, instanz);
    expect(erst.scripts).toBe('upgraded');
    expect(readFileSync(erst.promptSubmitPath, 'utf8')).not.toContain('npx');
    expect((await installAmbientHooks(projekt, instanz)).scripts).toBe('unchanged');
  });

  it('ein veraltetes Buendel allein loest die Erneuerung aus', async () => {
    const a = await installAmbientHooks(projekt, instanz);
    writeFileSync(a.bundlePath, '// alt\n');
    expect((await installAmbientHooks(projekt, instanz)).scripts).toBe('upgraded');
    expect(readFileSync(a.bundlePath, 'utf8')).toBe(readFileSync(BUENDEL, 'utf8'));
  });
});
