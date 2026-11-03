/**
 * CLS post-commit hook builder — robustness regression tests.
 *
 * The v1 hook interpolated the commit message into a `node -e "... '$MSG' ..."`
 * JS string, so any apostrophe broke the script and the hook silently ingested
 * nothing. These tests lock in the v2 contract: commit data flows through env
 * vars (never JS source) and the payload reaches the CLI via execFileSync.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClsPostCommitHook, installClsPostCommitHook, CLS_HOOK_VERSION, CLS_NODE_PROGRAM } from '../cls-hook.js';
import { commitThema } from '../ckg.js';

describe('commitThema: der Commit-Typ steht nur einmal im Thema (03.11.2026)', () => {
  it.each([
    ['fix', 'fix: pelican "upload" button doesn\'t respond', 'fix:pelican-upload-button-doesn-t-respond'],
    ['feat', 'feat(api)!: add retry header', 'feat:add-retry-header'],
    ['commit', 'Initial commit', 'commit:initial-commit'],
    ['fix', 'fix:', 'fix:fix:'],
  ])('%s + %j -> %s', (domain, nachricht, thema) => {
    expect(commitThema(domain, nachricht)).toBe(thema);
  });
});

describe('buildClsPostCommitHook', () => {
  it('embeds the instance id and version marker', () => {
    const hook = buildClsPostCommitHook('inst-123');
    expect(hook).toContain('export CACHLY_BRAIN_INSTANCE_ID="inst-123"');
    expect(hook).toContain(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`);
    expect(hook.startsWith('#!/bin/sh')).toBe(true);
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('embeds NO API key (v3): .git/hooks/post-commit lies inside the project folder', () => {
    expect(CLS_HOOK_VERSION).toBe('v4');
    expect(buildClsPostCommitHook('i')).not.toContain('CACHLY_JWT');
    // a caller still passing a key (older code, other tools) must not get it written
    expect(buildClsPostCommitHook('i', 'cky_live_abc')).not.toContain('cky_live_abc');
    expect(buildClsPostCommitHook('i', 'cky_live_abc')).not.toContain('CACHLY_JWT');
  });

  it('passes commit data via env vars, never interpolated into JS source', () => {
    const hook = buildClsPostCommitHook('i');
    // The node program must read from process.env, not from a "'$MSG'" literal.
    expect(hook).toContain('process.env.CLS_MSG');
    expect(hook).toContain('process.env.CLS_SHA');
    expect(hook).not.toContain("'$MSG'");
    expect(hook).not.toContain("'$SHA'");
    expect(hook).not.toContain("'$FILES'");
  });

  it('invokes the CLI via execFileSync (no shell re-parsing of the payload)', () => {
    const hook = buildClsPostCommitHook('i');
    expect(hook).toContain('execFileSync');
    expect(hook).toContain("'cls-ingest'");
    expect(hook).not.toContain('execSync'); // shell-based exec is the unsafe path
  });

  it('does not mangle the message with tr (no apostrophe-breaking transform)', () => {
    const hook = buildClsPostCommitHook('i');
    // v1 did `tr '"' "'"` which corrupted messages — must be gone.
    expect(hook).not.toContain(`tr '"'`);
  });
});

describe('installClsPostCommitHook (v3: kein Schluessel im Projekt)', () => {
  const ordner: string[] = [];
  afterEach(() => { for (const o of ordner.splice(0)) rmSync(o, { recursive: true, force: true }); });
  const projekt = () => {
    const p = mkdtempSync(join(tmpdir(), 'cachly-cls-'));
    ordner.push(p);
    mkdirSync(join(p, '.git', 'hooks'), { recursive: true });
    return p;
  };
  const V2_MIT_SCHLUESSEL = [
    '#!/bin/sh',
    '# cachly CLS — Continuous Learning Stream v2',
    'export CACHLY_BRAIN_INSTANCE_ID="i"',
    'export CACHLY_JWT="cky_live_geheim"',
    'exit 0',
    '',
  ].join('\n');

  it('legt den Hook ohne Schluessel an, auch wenn der Aufrufer einen uebergibt', async () => {
    const p = projekt();
    expect(await installClsPostCommitHook(p, 'i', 'cky_live_geheim')).toBe('written');
    const hook = readFileSync(join(p, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).not.toContain('cky_live_geheim');
    expect(hook).not.toContain('CACHLY_JWT');
  });

  it('ersetzt einen alten v2-Block MIT Schluessel beim naechsten init/setup', async () => {
    const p = projekt();
    writeFileSync(join(p, '.git', 'hooks', 'post-commit'), V2_MIT_SCHLUESSEL);
    expect(await installClsPostCommitHook(p, 'i')).toBe('upgraded');
    const hook = readFileSync(join(p, '.git', 'hooks', 'post-commit'), 'utf8');
    expect(hook).not.toContain('cky_live_geheim');
    expect(hook).toContain('Continuous Learning Stream v4');
  });
});

/**
 * v4 (03.11.2026): v3 rief `execFileSync('npx', …)` — unter Windows ENOENT
 * (npx ist dort npx.cmd), still verschluckt. Das Programm laeuft hier mit
 * nachgebauten Bausteinen: welcher Aufruf geht hinaus, und bleibt das JSON EIN
 * Argument, auch mit Anfuehrungszeichen, Apostroph, % und $ in der Nachricht?
 */
describe('CLS-Programm v4: npx-cli.js mit dem laufenden node, keine Shell', () => {
  type Aufruf = { programm: string; argumente: string[] };
  function fahre(opts: { plattform: string; execPath: string; vorhanden: string[]; nachricht: string }): Aufruf[] {
    const aufrufe: Aufruf[] = [];
    const sep = opts.plattform === 'win32' ? '\\' : '/';
    const pfad = {
      dirname: (x: string) => x.slice(0, x.lastIndexOf(sep)),
      join: (...teile: string[]) => teile.join(sep),
    };
    const fake = {
      child_process: { execFileSync: (programm: string, argumente: string[]) => { aufrufe.push({ programm, argumente }); } },
      path: pfad,
      fs: { existsSync: (f: string) => opts.vorhanden.includes(f) },
    } as Record<string, unknown>;
    const proc = {
      execPath: opts.execPath,
      platform: opts.plattform,
      env: { CACHLY_BRAIN_INSTANCE_ID: 'inst-1', CLS_MSG: opts.nachricht, CLS_SHA: 'abc123', CLS_FILES: 'a.ts,b.ts' },
    };
    new Function('require', 'process', CLS_NODE_PROGRAM)((name: string) => fake[name], proc);
    return aufrufe;
  }
  const nachricht = `fix: don't crash on "empty" input 100% %PATH% $HOME`;

  it('Windows: node.exe startet npx-cli.js, das JSON kommt als ein Argument an', () => {
    const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
    const a = fahre({ plattform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', vorhanden: [cli], nachricht });
    expect(a).toHaveLength(1);
    expect(a[0]!.programm).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(a[0]!.argumente.slice(0, 4)).toEqual([cli, '-y', '@cachly-dev/mcp-server@latest', 'cls-ingest']);
    const json = JSON.parse(a[0]!.argumente[4]!);
    expect(json).toEqual({ instance_id: 'inst-1', source: 'git_commit', payload: { message: nachricht, sha: 'abc123', files: ['a.ts', 'b.ts'] } });
  });

  it('Linux/macOS: npx-cli.js unter ../lib/node_modules', () => {
    const cli = '/usr/local/bin/../lib/node_modules/npm/bin/npx-cli.js';
    const a = fahre({ plattform: 'linux', execPath: '/usr/local/bin/node', vorhanden: [cli], nachricht });
    expect(a[0]!.programm).toBe('/usr/local/bin/node');
    expect(a[0]!.argumente[0]).toBe(cli);
  });

  it('ohne npx-cli.js: auf Linux npx direkt, unter Windows kein Aufruf statt eines sicheren Fehlschlags', () => {
    expect(fahre({ plattform: 'linux', execPath: '/opt/node/bin/node', vorhanden: [], nachricht })[0]!.programm).toBe('npx');
    expect(fahre({ plattform: 'win32', execPath: 'C:\\n\\node.exe', vorhanden: [], nachricht })).toHaveLength(0);
  });

  it('das Programm steht im Hook in doppelten Anfuehrungszeichen: kein ", kein $, kein Backtick, kein Backslash', () => {
    expect(CLS_NODE_PROGRAM).not.toMatch(/["$`\\]/);
    expect(buildClsPostCommitHook('i')).toContain(`node -e "${CLS_NODE_PROGRAM}"`);
  });
});
