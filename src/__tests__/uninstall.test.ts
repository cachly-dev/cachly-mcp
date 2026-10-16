import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildClaudeMdBlock, buildMcpConfig, writeInstructions,
} from '../index.js';
import {
  installAmbientHooks, installCodexHooks, installCopilotHooks, installCursorHooks, installGeminiHooks,
  buildAmbientSettingsHooks,
} from '../ambient-hooks.js';
import { installClsPostCommitHook } from '../cls-hook.js';
import { installBrainWatchHook } from '../brain-watch-hook.js';
import { credentialsPath } from '../credentials.js';
import { defaultLedgerPath } from '../ambient-ledger.js';
import { defaultMilestonePath } from '../funnel-milestones.js';
import { defaultKostprobePath } from '../kostprobe.js';
import { standPfad } from '../neue-fassung.js';
import { AUFTRAG, FEHLSCHLAG, SPERRE } from '../konto-anlegen.js';
import { bestandPfad, NETZ_PROTOKOLL, sicherungsPfad } from '../einblendung.js';
import { armePfad, lernOrdner } from '../lernen.js';
import { ablageDatei } from '../gueltigkeit-version.js';
import { CURSOR_ABLAGE_ORDNER } from '../cursor-hook.js';
import { COPILOT_ABLAGE_ORDNER } from '../copilot-hook.js';
import {
  entferneAnweisungsBlock, entferneGitHookBloecke, entferneHookEintraege, entferneMcpEintrag,
  fuehreAus, istCachlyAblage, istLeerNachRueckbau, klassifiziereAmbientHook, klassifiziereClaudeHook,
  plane, sammleBestand, uninstallBefehl, type Plan, type UninstallUmgebung,
} from '../uninstall.js';

/**
 * `uninstall` (GROW-027): nimmt zurueck, was init/setup/autopilot schreiben —
 * und nur das. Fremdes bleibt Zeichen fuer Zeichen. Alle Pfade sind temporaere
 * Ordner; der echte Heim- und Temp-Ordner werden nie gelesen.
 *
 * Gegenprobe (ohne git): schneideBlock so aendern, dass es nur den Block ohne
 * seine Zeilenumbrueche entfernt -> "CLAUDE.md wird byte-gleich" rot. Oder
 * klassifiziereClaudeHook nur auf den Schraegstrich-Pfad pruefen lassen ->
 * "erkennt Windows-Pfade mit Rueckstrich" rot.
 */

const IID = '11111111-2222-3333-4444-555555555555';
const KEY = 'cky_live_uninstalltest0000000000000000';

const ordner: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cachly-uninstall-test-'));
  ordner.push(d);
  return d;
}
afterEach(() => {
  for (const d of ordner.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function schreibe(wurzel: string, rel: string, inhalt: string): string {
  const p = join(wurzel, ...rel.split('/'));
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, inhalt, 'utf8');
  return p;
}

function baum(wurzel: string): Record<string, string> {
  const aus: Record<string, string> = {};
  const geh = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { aus[`${relative(wurzel, p).split('\\').join('/')}/`] = ''; geh(p); }
      else aus[relative(wurzel, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  geh(wurzel);
  return aus;
}

function angehaengt(original: string): string {
  return original + '\n' + buildClaudeMdBlock(IID) + '\n';
}

describe('entferneAnweisungsBlock: Text ausserhalb bleibt byte-gleich', () => {
  const faelle: Array<[string, string]> = [
    ['Text mit Zeilenumbruch am Ende', '# Mein Projekt\n\nRegeln:\n- eins\n'],
    ['Text ohne Zeilenumbruch am Ende', 'letzte Zeile ohne Umbruch'],
    ['Leerzeile am Ende', 'A\n\n'],
    ['Windows-Zeilenenden', 'A\r\nB\r\n'],
    ['Umlaute und Tabs', 'Grüße\t— ünïcode\n'],
  ];
  for (const [name, original] of faelle) {
    it(`angehaengt: ${name}`, () => {
      const r = entferneAnweisungsBlock(angehaengt(original));
      expect(r).toEqual({ art: 'entfernt', rest: original });
    });
  }

  it('frisch angelegte Datei: nichts bleibt uebrig', () => {
    const r = entferneAnweisungsBlock(buildClaudeMdBlock(IID) + '\n');
    expect(r).toEqual({ art: 'entfernt', rest: '' });
    expect(istLeerNachRueckbau('', false)).toBe(true);
  });

  it('Nutzertext nach dem Block bleibt und Zeilen wachsen nicht zusammen', () => {
    const block = buildClaudeMdBlock(IID);
    expect(entferneAnweisungsBlock(`Davor\n${block}\nDanach\n`)).toEqual({ art: 'entfernt', rest: 'Davor\nDanach\n' });
    expect(entferneAnweisungsBlock(`Davor\n\n${block}\nDanach\n`)).toEqual({ art: 'entfernt', rest: 'Davor\nDanach\n' });
    expect(entferneAnweisungsBlock(`${block}\nDanach\n`)).toEqual({ art: 'entfernt', rest: 'Danach\n' });
  });

  it('Block ohne Zeilenumbruch danach (Editor hat ihn entfernt)', () => {
    expect(entferneAnweisungsBlock('Davor\n' + buildClaudeMdBlock(IID))).toEqual({ art: 'entfernt', rest: 'Davor' });
  });

  it('kein Block / Marker ohne Gegenstueck', () => {
    expect(entferneAnweisungsBlock('nur Text\n')).toEqual({ art: 'kein-block' });
    expect(entferneAnweisungsBlock('Text\n<!-- cachly-brain-start -->\nohne Ende\n')).toEqual({ art: 'kaputt' });
    expect(entferneAnweisungsBlock('Text\n<!-- cachly-brain-end -->\n')).toEqual({ art: 'kaputt' });
  });

  it('Cursor .mdc: nur die Kopfzeilen uebrig heisst leer, eigener Text nicht', async () => {
    const d = tmp();
    await writeInstructions(d, IID);
    const mdc = readFileSync(join(d, '.cursor', 'rules', 'cachly.mdc'), 'utf8');
    const r = entferneAnweisungsBlock(mdc);
    expect(r.art).toBe('entfernt');
    if (r.art !== 'entfernt') return;
    expect(istLeerNachRueckbau(r.rest, true)).toBe(true);
    expect(istLeerNachRueckbau(r.rest, false)).toBe(false);
    expect(istLeerNachRueckbau(r.rest + 'Meine Regel\n', true)).toBe(false);
  });
});

describe('entferneMcpEintrag: fremde Server und Einstellungen bleiben', () => {
  const cachly = { command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'], env: { CACHLY_BRAIN_INSTANCE_ID: IID } };
  const fremd = { command: 'node', args: ['mein-server.js'] };

  it('mcpServers: fremder Server bleibt, Einzug bleibt', () => {
    const text = JSON.stringify({ mcpServers: { fremd, cachly } }, null, 4) + '\n';
    const r = entferneMcpEintrag(text, 'mcpServers');
    expect(r.art).toBe('geaendert');
    if (r.art !== 'geaendert') return;
    expect(r.nachher).toBe(JSON.stringify({ mcpServers: { fremd } }, null, 4) + '\n');
    expect(r.instanz).toBe(IID);
  });

  it('nur cachly in der Datei: die Datei ist danach leer (nachher null)', () => {
    const r = entferneMcpEintrag(buildMcpConfig(KEY, IID, 'claude'), 'mcpServers');
    expect(r).toMatchObject({ art: 'geaendert', nachher: null });
  });

  it('andere Schluessel der Datei bleiben, wenn mcpServers leer wird', () => {
    const r = entferneMcpEintrag(JSON.stringify({ a: 1, mcpServers: { cachly } }), 'mcpServers');
    expect(r.art === 'geaendert' && r.nachher).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it('kein cachly-Eintrag: nichts zu tun', () => {
    expect(entferneMcpEintrag(JSON.stringify({ mcpServers: { fremd } }), 'mcpServers')).toEqual({ art: 'nichts' });
    expect(entferneMcpEintrag('{}', 'mcpServers')).toEqual({ art: 'nichts' });
  });

  it('VS Code: servers.cachly und der Altbestand mcpServers.cachly; fremde Eintraege bleiben', () => {
    const text = JSON.stringify({ servers: { cachly, anders: fremd }, mcpServers: { cachly, alt: fremd } });
    const r = entferneMcpEintrag(text, 'vscode');
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({ servers: { anders: fremd }, mcpServers: { alt: fremd } });
  });

  it('Zed: nur context_servers.cachly, die uebrigen Einstellungen bleiben', () => {
    const text = JSON.stringify({ theme: 'One Dark', context_servers: { cachly: { command: { path: 'npx', env: { CACHLY_BRAIN_INSTANCE_ID: IID } } }, anders: {} } });
    const r = entferneMcpEintrag(text, 'zed');
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({ theme: 'One Dark', context_servers: { anders: {} } });
    expect(r.art === 'geaendert' && r.instanz).toBe(IID);
  });

  it('Continue: Eintraege mit cachly-Umgebung oder Paketnamen, fremde bleiben', () => {
    const text = JSON.stringify({
      models: [],
      experimental: {
        modelContextProtocolServers: [
          { transport: { type: 'stdio', command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'] }, env: { CACHLY_BRAIN_INSTANCE_ID: IID } },
          { transport: { type: 'stdio', command: 'node', args: ['x.js'] } },
          { transport: { type: 'stdio', command: 'npx', args: ['@cachly-dev/mcp-server'] } },
        ],
      },
    });
    const r = entferneMcpEintrag(text, 'continue');
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({
      models: [],
      experimental: { modelContextProtocolServers: [{ transport: { type: 'stdio', command: 'node', args: ['x.js'] } }] },
    });
  });

  it('Continue: nur cachly -> experimental faellt ganz weg', () => {
    const text = JSON.stringify({ models: [], experimental: { modelContextProtocolServers: [{ env: { CACHLY_JWT: 'x' } }] } });
    const r = entferneMcpEintrag(text, 'continue');
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({ models: [] });
  });

  it('Kommentare oder BOM: unlesbar, wird nicht angefasst', () => {
    expect(entferneMcpEintrag('{ // meins\n "mcpServers": { "cachly": {} } }', 'mcpServers')).toEqual({ art: 'unlesbar' });
    expect(entferneMcpEintrag('\ufeff{"mcpServers":{"cachly":{}}}', 'mcpServers')).toEqual({ art: 'unlesbar' });
    expect(entferneMcpEintrag('[1,2]', 'mcpServers')).toEqual({ art: 'unlesbar' });
  });
});

describe('entferneHookEintraege: Claude-Einstellungen', () => {
  const ambient = (pfad: string) => buildAmbientSettingsHooks({ sessionStart: pfad, userPromptSubmit: pfad, stop: pfad });

  it('erkennt Windows-Pfade mit Rueckstrich und Pfade mit Schraegstrich', () => {
    for (const pfad of [
      'C:\\Users\\ich\\proj\\.claude\\hooks\\cachly-ambient-session-start.mjs',
      '/home/ich/proj/.claude/hooks/cachly-ambient-session-start.mjs',
      '$CLAUDE_PROJECT_DIR/.claude/hooks/cachly-ambient-session-start.mjs',
    ]) {
      const text = JSON.stringify({ hooks: ambient(pfad) });
      expect(klassifiziereClaudeHook({ type: 'command', command: `node "${pfad}"` }), pfad).toBe('ambient');
      const r = entferneHookEintraege(text, klassifiziereClaudeHook);
      expect(r, pfad).toMatchObject({ art: 'geaendert', nachher: null });
    }
  });

  it('fremder Hook und fremde Schluessel bleiben; leere Gruppen und Ereignisse fallen weg', () => {
    const fremdHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "mein Hook"' }] };
    const text = JSON.stringify({
      permissions: { allow: ['Bash(ls)'] },
      env: { FOO: '1' },
      hooks: {
        ...ambient('C:\\p\\.claude\\hooks\\cachly-ambient-x.mjs'),
        PreToolUse: [fremdHook, ...buildAmbientSettingsHooks({ sessionStart: 'a', userPromptSubmit: 'b', preToolUse: '/p/.claude/hooks/cachly-ambient-pre-tool.mjs' }).PreToolUse!],
      },
    }, null, 2);
    const r = entferneHookEintraege(text, klassifiziereClaudeHook);
    expect(r.art).toBe('geaendert');
    if (r.art !== 'geaendert') return;
    expect(JSON.parse(r.nachher ?? '{}')).toEqual({
      permissions: { allow: ['Bash(ls)'] },
      env: { FOO: '1' },
      hooks: { PreToolUse: [fremdHook] },
    });
  });

  it('gemischte Gruppe: nur der cachly-Befehl faellt, der fremde Befehl in derselben Gruppe bleibt', () => {
    const text = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [
        { type: 'command', command: 'node "/p/.claude/hooks/cachly-ambient-prompt-submit.mjs"' },
        { type: 'command', command: 'echo fremd' },
      ] }] },
    });
    const r = entferneHookEintraege(text, klassifiziereClaudeHook);
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo fremd' }] }] },
    });
  });

  it('kaputter Stop-Hook aus setup_ai_memory faellt, ein fremder Stop-Hook daneben bleibt', () => {
    const kaputt = { matcher: '', hooks: [{ type: 'command', command: `npx --yes @cachly-dev/mcp-server@latest checkpoint --instance-id ${IID}` }] };
    const fremdStop = { matcher: '', hooks: [{ type: 'command', command: 'node mein-stop.js' }] };
    const andererBefehl = { matcher: '', hooks: [{ type: 'command', command: 'npx @cachly-dev/mcp-server@latest doctor' }] };
    const text = JSON.stringify({ hooks: { Stop: [fremdStop, kaputt, andererBefehl] } });
    const r = entferneHookEintraege(text, klassifiziereClaudeHook);
    expect(r).toMatchObject({ art: 'geaendert', entfernt: ['checkpoint'] });
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({ hooks: { Stop: [fremdStop, andererBefehl] } });
    expect(klassifiziereAmbientHook(kaputt.hooks[0])).toBeNull();
  });

  it('nur der kaputte Stop-Hook in der Datei: Datei ist danach leer', () => {
    const text = JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `npx --yes @cachly-dev/mcp-server@latest checkpoint --instance-id ${IID}` }] }] } }, null, 2);
    expect(entferneHookEintraege(text, klassifiziereClaudeHook)).toMatchObject({ art: 'geaendert', nachher: null });
  });

  it('flache Listen (Cursor, Copilot): fremder Eintrag bleibt; nur `version` uebrig heisst leer', () => {
    const cursor = JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: 'node .cursor/hooks/cachly-ambient-cursor.mjs sessionStart', timeout: 30 }, { command: 'echo fremd' }] },
    });
    const r = entferneHookEintraege(cursor, klassifiziereAmbientHook, ['version']);
    expect(r.art === 'geaendert' && JSON.parse(r.nachher ?? '{}')).toEqual({ version: 1, hooks: { sessionStart: [{ command: 'echo fremd' }] } });

    const nurUnsere = JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'node .cursor/hooks/cachly-ambient-cursor.mjs sessionStart' }] } });
    expect(entferneHookEintraege(nurUnsere, klassifiziereAmbientHook, ['version'])).toMatchObject({ art: 'geaendert', nachher: null });
    expect(entferneHookEintraege(nurUnsere, klassifiziereAmbientHook, [])).toMatchObject({ art: 'geaendert' });
  });

  it('Kommentare: unlesbar; ohne hooks: nichts', () => {
    expect(entferneHookEintraege('{ // x\n}', klassifiziereAmbientHook)).toEqual({ art: 'unlesbar' });
    expect(entferneHookEintraege('{"theme":"dark"}', klassifiziereAmbientHook)).toEqual({ art: 'nichts' });
  });
});

describe('entferneGitHookBloecke: post-commit', () => {
  it('fremder Befehl bleibt, wenn der CLS-Block angehaengt wurde', async () => {
    const d = tmp();
    const original = '#!/bin/sh\necho "mein eigener Hook"\n';
    const pfad = schreibe(d, '.git/hooks/post-commit', original);
    expect(await installClsPostCommitHook(d, IID)).toBe('appended');
    const r = entferneGitHookBloecke(readFileSync(pfad, 'utf8'));
    expect(r).toEqual({ rest: original, entfernt: ['CLS hook'] });
  });

  it('beide Bloecke (CLS und brain_watch) hinter einem fremden Befehl', async () => {
    const d = tmp();
    const original = '#!/bin/sh\nnotify-send commit\n';
    const pfad = schreibe(d, '.git/hooks/post-commit', original);
    await installClsPostCommitHook(d, IID);
    await installBrainWatchHook(d, IID);
    const r = entferneGitHookBloecke(readFileSync(pfad, 'utf8'));
    expect(r.entfernt).toEqual(['CLS hook', 'brain_watch hook']);
    expect(r.rest).toBe(original);
  });

  it('Hook nur von cachly: nichts bleibt', async () => {
    const d = tmp();
    mkdirSync(join(d, '.git'));
    await installClsPostCommitHook(d, IID);
    const r = entferneGitHookBloecke(readFileSync(join(d, '.git', 'hooks', 'post-commit'), 'utf8'));
    expect(r.rest).toBe('');
  });

  it('ohne cachly-Block: Text unveraendert', () => {
    expect(entferneGitHookBloecke('#!/bin/sh\necho hi\n')).toEqual({ rest: '#!/bin/sh\necho hi\n', entfernt: [] });
  });
});

describe('plane und fuehreAus: ein Projekt mit allem, was cachly schreibt', () => {
  async function richteEin(d: string): Promise<{ vorher: Record<string, string> }> {
    const fremdeMcp = { mcpServers: { fremd: { command: 'node', args: ['x.js'] } } };
    schreibe(d, 'CLAUDE.md', '# Mein Projekt\n\nMeine Regeln.\n');
    schreibe(d, 'AGENTS.md', 'Agenten-Text ohne Umbruch am Ende');
    schreibe(d, '.mcp.json', JSON.stringify(fremdeMcp, null, 2));
    schreibe(d, '.git/hooks/post-commit', '#!/bin/sh\necho eigener-hook\n');
    schreibe(d, '.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node mein-stop.js' }] }] } }, null, 2) + '\n');
    schreibe(d, '.cursor/hooks.json', JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: 'echo fremd' }] } }, null, 2) + '\n');
    schreibe(d, '.codex/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo codex-fremd' }] }] } }, null, 2) + '\n');
    schreibe(d, '.gemini/settings.json', JSON.stringify({ theme: 'dark', mcpServers: {} }, null, 2) + '\n');
    schreibe(d, '.github/hooks/meine.json', '{"version":1,"hooks":{}}');
    const vorher = baum(d);

    schreibe(d, '.cursor/mcp.json', buildMcpConfig(KEY, IID, 'cursor'));
    schreibe(d, '.windsurf/mcp.json', buildMcpConfig(KEY, IID, 'windsurf'));
    schreibe(d, '.vscode/mcp.json', buildMcpConfig(KEY, IID, 'copilot'));
    schreibe(d, '.continue/config.json', buildMcpConfig(KEY, IID, 'continue'));
    schreibe(d, '.zed/settings.json', buildMcpConfig(KEY, IID, 'zed'));
    const mcp = JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    mcp.mcpServers.cachly = JSON.parse(buildMcpConfig(KEY, IID, 'claude')).mcpServers.cachly;
    writeFileSync(join(d, '.mcp.json'), JSON.stringify(mcp, null, 2));
    await writeInstructions(d, IID);
    await installClsPostCommitHook(d, IID);
    await installBrainWatchHook(d, IID);
    await installAmbientHooks(d, IID);
    await installCursorHooks(d, IID);
    await installCopilotHooks(d, IID);
    await installCodexHooks(d, IID);
    await installGeminiHooks(d, IID);
    return { vorher };
  }

  it('Rueckbau stellt den Stand vor init her: Fremdes byte-gleich, nichts von cachly uebrig, keine leeren Ordner', async () => {
    const d = tmp();
    const { vorher } = await richteEin(d);
    expect(baum(d)).not.toEqual(vorher);

    const plan = plane({ projekt: d, heim: join(d, '_heim'), tmp: join(d, '_tmp') });
    const zeilen = fuehreAus(plan.funde.filter((f) => f.stufe === 'projekt'));
    expect(zeilen.filter((z) => z.status === 'uebersprungen' && z.fund.aktion !== 'melden')).toEqual([]);

    const nachher = baum(d);
    const unterschiede = Object.keys({ ...vorher, ...nachher }).filter((k) => vorher[k] !== nachher[k]);
    const erwartet = ['.mcp.json'];
    expect(unterschiede.filter((k) => !erwartet.includes(k))).toEqual([]);
    expect(JSON.parse(nachher['.mcp.json']!)).toEqual({ mcpServers: { fremd: { command: 'node', args: ['x.js'] } } });
    expect(Object.keys(nachher).filter((k) => /cachly/i.test(k))).toEqual([]);
    expect(Object.values(nachher).some((t) => t.includes('cachly-brain-start') || t.includes('cachly-ambient-'))).toBe(false);
  });

  it('der Plan nennt jede Fundstelle mit ihrer Aktion', async () => {
    const d = tmp();
    await richteEin(d);
    const plan = plane({ projekt: d, heim: join(d, '_heim'), tmp: join(d, '_tmp') });
    const nach = Object.fromEntries(plan.funde.map((f) => [relative(d, f.pfad).split('\\').join('/'), f.aktion]));
    expect(nach['CLAUDE.md']).toBe('block-entfernen');
    expect(nach['AGENTS.md']).toBe('block-entfernen');
    expect(nach['.github/copilot-instructions.md']).toBe('datei-loeschen');
    expect(nach['.cursor/rules/cachly.mdc']).toBe('datei-loeschen');
    expect(nach['.windsurfrules']).toBe('datei-loeschen');
    expect(nach['.mcp.json']).toBe('eintrag-entfernen');
    expect(nach['.cursor/mcp.json']).toBe('datei-loeschen');
    expect(nach['.vscode/mcp.json']).toBe('datei-loeschen');
    expect(nach['.continue/config.json']).toBe('datei-loeschen');
    expect(nach['.zed/settings.json']).toBe('datei-loeschen');
    expect(nach['.claude/settings.json']).toBe('eintrag-entfernen');
    expect(nach['.claude/hooks/cachly-ambient-stop.mjs']).toBe('datei-loeschen');
    expect(nach['.claude/hooks/cachly-ambient-einblendung.mjs']).toBe('datei-loeschen');
    expect(nach['.claude/hooks']).toBe('ordner-entfernen');
    expect(nach['.cursor/hooks.json']).toBe('eintrag-entfernen');
    expect(nach['.cursor/hooks/cachly-ambient-cursor.mjs']).toBe('datei-loeschen');
    expect(nach['.github/hooks/cachly-ambient.json']).toBe('datei-loeschen');
    expect(nach['.github/hooks/cachly-ambient-copilot.mjs']).toBe('datei-loeschen');
    expect(nach['.codex/hooks.json']).toBe('eintrag-entfernen');
    expect(nach['.gemini/settings.json']).toBe('eintrag-entfernen');
    expect(nach['.git/hooks/post-commit']).toBe('block-entfernen');
    expect(nach['.github/hooks']).toBeUndefined();
    expect(nach['.git']).toBeUndefined();
  });

  it('Datei, die sich nach dem Plan aendert, wird uebersprungen', async () => {
    const d = tmp();
    schreibe(d, 'CLAUDE.md', angehaengt('Mein Text\n'));
    const plan = plane({ projekt: d, heim: join(d, '_h'), tmp: join(d, '_t') });
    writeFileSync(join(d, 'CLAUDE.md'), 'inzwischen etwas ganz anderes', 'utf8');
    const zeilen = fuehreAus(plan.funde);
    expect(zeilen[0]).toMatchObject({ status: 'uebersprungen' });
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toBe('inzwischen etwas ganz anderes');
  });

  it('nicht lesbare Dateien (Kommentare) bleiben byte-gleich und stehen in der Von-Hand-Liste', () => {
    const d = tmp();
    const jsonc = '{\n  // meine Notiz\n  "mcpServers": { "cachly": { "command": "npx" } }\n}\n';
    const gemini = '{ /* Kommentar */ "hooks": { "SessionStart": [{ "hooks": [{ "command": "node .gemini/hooks/cachly-ambient-gemini.mjs" }] }] } }';
    schreibe(d, '.mcp.json', jsonc);
    schreibe(d, '.gemini/settings.json', gemini);
    schreibe(d, '.zed/settings.json', '// Zed\n{ "context_servers": { "cachly": {} } }');
    const plan = plane({ projekt: d, heim: join(d, '_h'), tmp: join(d, '_t') });
    expect(plan.funde).toEqual([]);
    fuehreAus(plan.funde);
    expect(readFileSync(join(d, '.mcp.json'), 'utf8')).toBe(jsonc);
    expect(readFileSync(join(d, '.gemini', 'settings.json'), 'utf8')).toBe(gemini);
    const texte = plan.vonHand.map((h) => h.text).join('\n');
    expect(texte).toContain('.mcp.json');
    expect(texte).toContain('.gemini/settings.json');
    expect(texte).toContain('.zed/settings.json');
  });

  it('.bak und Worktree-.git werden nur gemeldet', () => {
    const d = tmp();
    schreibe(d, '.mcp.json.bak', '{ alt }');
    schreibe(d, '.git', 'gitdir: /irgendwo/.git/worktrees/x\n');
    const plan = plane({ projekt: d, heim: join(d, '_h'), tmp: join(d, '_t') });
    expect(plan.funde).toMatchObject([{ aktion: 'melden', was: expect.stringContaining('your old file is there') }]);
    expect(plan.vonHand.map((h) => h.text).join('\n')).toContain('worktree');
    expect(fuehreAus(plan.funde)[0]).toMatchObject({ status: 'uebersprungen' });
    expect(readFileSync(join(d, '.mcp.json.bak'), 'utf8')).toBe('{ alt }');
  });

  it('eigene Dateien daneben halten einen Ordner am Leben', async () => {
    const d = tmp();
    await installAmbientHooks(d, IID);
    schreibe(d, '.claude/hooks/mein-eigener-hook.sh', 'echo hi');
    const plan = plane({ projekt: d, heim: join(d, '_h'), tmp: join(d, '_t') });
    fuehreAus(plan.funde);
    expect(existsSync(join(d, '.claude', 'hooks', 'mein-eigener-hook.sh'))).toBe(true);
    expect(readdirSync(join(d, '.claude', 'hooks'))).toEqual(['mein-eigener-hook.sh']);
    expect(plan.funde.some((f) => f.aktion === 'ordner-entfernen')).toBe(false);
  });
});

describe('Heimordner und Temp-Ordner (--global)', () => {
  function heimMitAllem(): { heim: string; tmpD: string } {
    const wurzel = tmp();
    const heim = join(wurzel, 'heim');
    const tmpD = join(wurzel, 'tmp');
    mkdirSync(tmpD, { recursive: true });
    for (const p of [
      credentialsPath({ home: heim }), join(heim, '.cachly', basename(defaultLedgerPath())), join(heim, '.cachly', basename(defaultMilestonePath())),
      join(heim, '.cachly', basename(defaultKostprobePath())), standPfad(heim), join(heim, '.cachly', SPERRE),
      join(heim, '.cachly', FEHLSCHLAG), join(heim, '.cachly', AUFTRAG), join(heim, '.cachly', `${AUFTRAG}.4711.genommen`),
      `${credentialsPath({ home: heim })}.4711-1.tmp`,
    ]) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '{}', 'utf8'); }
    return { heim, tmpD };
  }

  it('loescht genau die Dateien von cachly und dann den leeren Ordner ~/.cachly', () => {
    const { heim, tmpD } = heimMitAllem();
    schreibe(heim, '.claude/mcp.json', JSON.stringify({ mcpServers: { cachly: { command: 'npx', env: { CACHLY_JWT: KEY } }, fremd: { command: 'x' } } }, null, 2));
    schreibe(heim, '.cursor/mcp.json', JSON.stringify({ mcpServers: { cachly: { command: 'npx' } } }));
    const plan = plane({ projekt: join(heim, 'proj'), heim, tmp: tmpD });
    const global = plan.funde.filter((f) => f.stufe === 'global');
    expect(global.find((f) => f.pfad.endsWith('mcp.json') && f.pfad.includes('.cursor'))?.aktion).toBe('melden');
    fuehreAus(global);
    expect(existsSync(join(heim, '.cachly'))).toBe(false);
    expect(JSON.parse(readFileSync(join(heim, '.claude', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { fremd: { command: 'x' } } });
    expect(readFileSync(join(heim, '.cursor', 'mcp.json'), 'utf8')).toContain('cachly');
  });

  it('Fremdes in ~/.cachly bleibt und wird genannt; der Ordner bleibt', () => {
    const { heim, tmpD } = heimMitAllem();
    schreibe(heim, '.cachly/vscode-mcp.env', 'CACHLY_JWT=geheim');
    schreibe(heim, '.cachly/bench-korpus/a.json', '{}');
    const plan = plane({ projekt: join(heim, 'proj'), heim, tmp: tmpD });
    fuehreAus(plan.funde.filter((f) => f.stufe === 'global'));
    expect(readdirSync(join(heim, '.cachly')).sort()).toEqual(['bench-korpus', 'vscode-mcp.env']);
    const text = plan.vonHand.filter((h) => h.stufe === 'global').map((h) => h.text).join('\n');
    expect(text).toContain('vscode-mcp.env');
    expect(text).toContain('bench-korpus');
  });

  it('Temp-Ordner: nur bekannte Ablagen; Ordner und Dateien mit aehnlichem Namen bleiben', () => {
    const { heim, tmpD } = heimMitAllem();
    schreibe(tmpD, 'cachly-ambient-netlog.jsonl', '{}');
    schreibe(tmpD, 'cachly-ambient-bestand-0123456789ab.json', '{}');
    schreibe(tmpD, 'cachly-lernen/a.jsonl', '{}');
    schreibe(tmpD, 'cachly-mein-projekt/src/main.ts', 'export {}');
    schreibe(tmpD, 'cachly-notizen.txt', 'meine Notizen');
    schreibe(tmpD, 'andere.json', '{}');
    const plan = plane({ projekt: join(heim, 'proj'), heim, tmp: tmpD });
    fuehreAus(plan.funde.filter((f) => f.stufe === 'global'));
    expect(readdirSync(tmpD).sort()).toEqual(['andere.json', 'cachly-mein-projekt', 'cachly-notizen.txt']);
  });

  it('jede Ablage, die die Module im Temp-Ordner anlegen, wird erkannt', () => {
    const dateien = [
      basename(bestandPfad(IID)), basename(sicherungsPfad(IID)), basename(NETZ_PROTOKOLL), basename(armePfad(IID)),
      basename(ablageDatei('/irgendein/ordner')), 'cachly-ambient-auffrischen-0123456789ab.lock', 'cachly-startwissen-import-0123456789ab.lock',
    ];
    for (const n of dateien) expect(istCachlyAblage(n, false), n).toBe(true);
    for (const n of [basename(lernOrdner()), basename(CURSOR_ABLAGE_ORDNER), basename(COPILOT_ABLAGE_ORDNER)]) {
      expect(istCachlyAblage(n, true), n).toBe(true);
    }
    expect(istCachlyAblage('cachly-mein-projekt', true)).toBe(false);
    expect(istCachlyAblage('cachly-notizen.txt', false)).toBe(false);
  });
});

describe('sammleBestand und uninstallBefehl', () => {
  function umgebung(d: string, extra: Partial<UninstallUmgebung> = {}): { u: UninstallUmgebung; zeilen: string[]; fragen: string[] } {
    const zeilen: string[] = [];
    const fragen: string[] = [];
    const u: UninstallUmgebung = {
      projekt: join(d, 'proj'), heim: join(d, 'heim'), tmp: join(d, 'tmp'), schluessel: '', instanz: '', apiUrl: 'http://127.0.0.1:9',
      istTty: false, ausgabe: (z) => zeilen.push(z), frage: async (t) => { fragen.push(t); return false; }, ...extra,
    };
    mkdirSync(u.projekt, { recursive: true });
    mkdirSync(u.heim, { recursive: true });
    mkdirSync(u.tmp, { recursive: true });
    return { u, zeilen, fragen };
  }
  const antwort = (zahl: number): typeof fetch => (async () => new Response(JSON.stringify({ lesson_count: zahl }), { status: 200 })) as unknown as typeof fetch;

  it('Bestand: Schluesselart, Lektionen, Bilanz aus dem Ledger', async () => {
    const d = tmp();
    const heim = join(d, 'heim');
    schreibe(heim, '.cachly/ambient-ledger.jsonl', [
      JSON.stringify({ ts: '2026-10-01T10:00:00Z', event: 'UserPromptSubmit', injected: 300, prevented: 0 }),
      JSON.stringify({ ts: '2026-10-01T10:05:00Z', event: 'credit', injected: 0, prevented: 1000 }),
      'kaputte Zeile',
    ].join('\n') + '\n');
    const urls: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      urls.push(`${url} ${(init.headers as Record<string, string>).Authorization}`);
      return new Response(JSON.stringify({ lesson_count: 42 }), { status: 200 });
    }) as unknown as typeof fetch;
    const b = await sammleBestand({ heim, schluessel: 'cky_trial_abcdefgh1234', instanz: IID, apiUrl: 'http://127.0.0.1:1', fetchFn });
    expect(b).toMatchObject({ schluessel: 'test', turns: 2, injected: 300, prevented: 1000, net: 700, lektionen: 42 });
    expect(urls).toEqual([`http://127.0.0.1:1/api/v1/instances/${IID}/memory Bearer cky_trial_abcdefgh1234`]);
    expect((await sammleBestand({ heim, schluessel: KEY, instanz: IID, apiUrl: 'x', fetchFn })).schluessel).toBe('konto');
  });

  it('Bestand: Fehler und fehlende Angaben heissen "nicht abrufbar", nicht Null', async () => {
    const d = tmp();
    const kaputt = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await sammleBestand({ heim: d, schluessel: KEY, instanz: IID, apiUrl: 'x', fetchFn: kaputt })).toMatchObject({ lektionen: null, lektionenFehlt: 'unreachable' });
    const fehler = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    expect(await sammleBestand({ heim: d, schluessel: KEY, instanz: IID, apiUrl: 'x', fetchFn: fehler })).toMatchObject({ lektionen: null, lektionenFehlt: 'unreachable' });
    expect(await sammleBestand({ heim: d, schluessel: '', instanz: '', apiUrl: 'x' })).toMatchObject({ schluessel: 'keiner', lektionen: null, lektionenFehlt: 'no-instance' });
  });

  it('--dry-run: zeigt Zahlen und Plan, aendert nichts, Exit 0', async () => {
    const d = tmp();
    const { u, zeilen } = umgebung(d, { schluessel: KEY, instanz: IID, fetchFn: antwort(7) });
    schreibe(u.projekt, 'CLAUDE.md', angehaengt('Mein Text\n'));
    schreibe(u.projekt, '.mcp.json.bak', '{}');
    const vorher = baum(d);
    expect(await uninstallBefehl(['--dry-run'], u)).toBe(0);
    expect(baum(d)).toEqual(vorher);
    const text = zeilen.join('\n');
    expect(text).toContain('7 in your Brain');
    expect(text).toContain('npx @cachly-dev/mcp-server@latest export');
    expect(text).toMatch(/remove block\s+CLAUDE\.md/);
    expect(text).toContain('your old file is there');
    expect(text).toContain('Dry run: nothing was changed.');
    expect(text).toContain('never deletes cloud data');
    expect(text).toContain('privacy@cachly.dev');
  });

  it('der Plan benennt den kaputten Stop-Hook aus setup_ai_memory', async () => {
    const d = tmp();
    const { u, zeilen } = umgebung(d);
    schreibe(u.projekt, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [
      { matcher: '', hooks: [{ type: 'command', command: `npx --yes @cachly-dev/mcp-server@latest checkpoint --instance-id ${IID}` }] },
      { hooks: [{ type: 'command', command: 'node mein-stop.js' }] },
    ] } }, null, 2));
    expect(await uninstallBefehl(['--dry-run'], u)).toBe(0);
    expect(zeilen.join('\n')).toContain('broken Stop hook from setup_ai_memory');
  });

  it('ohne Terminal und ohne --yes: Abbruch mit Hinweis, nichts geaendert, Exit 1', async () => {
    const d = tmp();
    const { u, zeilen, fragen } = umgebung(d);
    schreibe(u.projekt, 'CLAUDE.md', angehaengt('Mein Text\n'));
    const vorher = baum(d);
    expect(await uninstallBefehl([], u)).toBe(1);
    expect(baum(d)).toEqual(vorher);
    expect(fragen).toEqual([]);
    expect(zeilen.join('\n')).toContain('--yes');
  });

  it('im Terminal: Antwort nein aendert nichts, Antwort ja entfernt', async () => {
    const d = tmp();
    const nein = umgebung(d, { istTty: true });
    schreibe(nein.u.projekt, 'CLAUDE.md', angehaengt('Mein Text\n'));
    const vorher = baum(d);
    expect(await uninstallBefehl([], nein.u)).toBe(0);
    expect(nein.fragen).toHaveLength(1);
    expect(baum(d)).toEqual(vorher);

    const ja = umgebung(d, { istTty: true, frage: async () => true });
    expect(await uninstallBefehl([], ja.u)).toBe(0);
    expect(readFileSync(join(ja.u.projekt, 'CLAUDE.md'), 'utf8')).toBe('Mein Text\n');
  });

  it('nichts gefunden: sagt es und endet mit Exit 0', async () => {
    const d = tmp();
    const { u, zeilen } = umgebung(d);
    expect(await uninstallBefehl(['--yes'], u)).toBe(0);
    expect(zeilen.join('\n')).toContain('Nothing found');
  });

  it('Standard nur das Projekt: der Heimordner bleibt, ein Hinweis nennt --global', async () => {
    const d = tmp();
    const { u, zeilen } = umgebung(d);
    schreibe(u.projekt, 'CLAUDE.md', angehaengt('Mein Text\n'));
    schreibe(u.heim, '.cachly/credentials.json', JSON.stringify({ apiKey: KEY }));
    expect(await uninstallBefehl(['--yes'], u)).toBe(0);
    expect(existsSync(join(u.heim, '.cachly', 'credentials.json'))).toBe(true);
    expect(zeilen.join('\n')).toContain('uninstall --global');
  });

  it('--global fragt zweimal, warnt vor dem Schluessel, und ein Nein laesst den Heimordner stehen', async () => {
    const d = tmp();
    const antworten = [true, false];
    const fragen: string[] = [];
    const { u, zeilen } = umgebung(d, {
      istTty: true, schluessel: 'cky_trial_abcdefgh1234',
      frage: async (t) => { fragen.push(t); return antworten.shift() ?? false; },
    });
    schreibe(u.projekt, 'CLAUDE.md', angehaengt('Mein Text\n'));
    schreibe(u.heim, '.cachly/credentials.json', JSON.stringify({ apiKey: 'cky_trial_abcdefgh1234' }));
    expect(await uninstallBefehl(['--global'], u)).toBe(0);
    expect(fragen).toHaveLength(2);
    expect(zeilen.join('\n')).toContain('Other projects on this computer lose their access');
    expect(zeilen.join('\n')).toContain('claim');
    expect(readFileSync(join(u.projekt, 'CLAUDE.md'), 'utf8')).toBe('Mein Text\n');
    expect(existsSync(join(u.heim, '.cachly', 'credentials.json'))).toBe(true);
  });

  it('--global --yes loescht die Schluesseldatei', async () => {
    const d = tmp();
    const { u } = umgebung(d);
    schreibe(u.heim, '.cachly/credentials.json', JSON.stringify({ apiKey: KEY }));
    expect(await uninstallBefehl(['--global', '--yes'], u)).toBe(0);
    expect(existsSync(join(u.heim, '.cachly'))).toBe(false);
  });
});

describe('Plan-Typen', () => {
  it('Plan ohne Funde ist leer', () => {
    const d = tmp();
    const plan: Plan = plane({ projekt: d, heim: join(d, 'h'), tmp: join(d, 't') });
    expect(plan.funde).toEqual([]);
  });
});
