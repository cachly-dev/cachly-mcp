import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { installBrainWatchHook, ohneBrainWatchBlock } from '../brain-watch-hook.js';
import { CLS_HOOK_VERSION } from '../cls-hook.js';
import { handleFedbrainTool } from '../handlers/fedbrain.js';
import { ALTER_BRAIN_WATCH_BLOCK } from './alter-brain-watch-block.js';

/**
 * brain_watch richtet seit 0.10.206 den CLS-Hook ein (wie init) und raeumt den
 * alten Block weg, der den Schluessel im Klartext in .git/hooks/post-commit trug.
 *
 * Gegenprobe: in installBrainWatchHook die Zeile `if (bereinigt !== null) await writeFile(...)`
 * entfernen -> die Faelle mit Altbestand werden rot (Schluessel bleibt stehen).
 */

const IID = 'inst-1';
const CLS_MARKER = `# cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`;

let ordner: string[] = [];
afterEach(() => { for (const o of ordner) rmSync(o, { recursive: true, force: true }); ordner = []; });

function repo(postCommit?: string): { d: string; hook: string } {
  const d = mkdtempSync(join(tmpdir(), 'cachly-brain-watch-'));
  ordner.push(d);
  mkdirSync(join(d, '.git', 'hooks'), { recursive: true });
  const hook = join(d, '.git', 'hooks', 'post-commit');
  if (postCommit !== undefined) writeFileSync(hook, postCommit);
  return { d, hook };
}

const vorkommen = (text: string, teil: string) => text.split(teil).length - 1;

describe('installBrainWatchHook', () => {
  it('neues Repo: CLS-Hook, kein Schluessel, kein brain_watch-Block', async () => {
    const { d, hook } = repo();
    const r = await installBrainWatchHook(d, IID);
    expect(r).toMatchObject({ result: 'written', alterBlockEntfernt: false });
    const text = readFileSync(hook, 'utf8');
    expect(text).toContain(CLS_MARKER);
    expect(text).not.toContain('brain_watch');
    expect(text).not.toContain('CACHLY_JWT=');
  });

  it('alter Block mit Schluessel hinter fremdem Befehl: Schluessel weg, fremde Zeile bleibt, CLS einmal', async () => {
    const fremd = '#!/bin/sh\nnotify-send commit\n';
    const { d, hook } = repo(fremd + '\n' + ALTER_BRAIN_WATCH_BLOCK + '\n');
    const r = await installBrainWatchHook(d, IID);
    expect(r.alterBlockEntfernt).toBe(true);
    const text = readFileSync(hook, 'utf8');
    expect(text).not.toContain('cky_live_geheim');
    expect(text).not.toContain('# cachly brain_watch');
    expect(text.startsWith(fremd)).toBe(true);
    expect(vorkommen(text, CLS_MARKER)).toBe(1);
  });

  it('alter Block neben aktuellem CLS-Hook: nur der alte geht, Ergebnis "upgraded"', async () => {
    const { d, hook } = repo();
    await installBrainWatchHook(d, IID);
    writeFileSync(hook, readFileSync(hook, 'utf8').trimEnd() + '\n\n' + ALTER_BRAIN_WATCH_BLOCK + '\n');
    const r = await installBrainWatchHook(d, IID);
    expect(r.result).toBe('upgraded');
    const text = readFileSync(hook, 'utf8');
    expect(text).not.toContain('cky_live_geheim');
    expect(vorkommen(text, CLS_MARKER)).toBe(1);
  });

  it('zweiter Aufruf aendert nichts', async () => {
    const { d, hook } = repo();
    await installBrainWatchHook(d, IID);
    const vorher = readFileSync(hook, 'utf8');
    expect((await installBrainWatchHook(d, IID)).result).toBe('unchanged');
    expect(readFileSync(hook, 'utf8')).toBe(vorher);
  });

  it('instance_id mit Shell-Zeichen: wirft, bevor die Datei angefasst wird', async () => {
    const alt = '#!/bin/sh\n' + ALTER_BRAIN_WATCH_BLOCK.replace('#!/bin/sh\n', '') + '\n';
    const { d, hook } = repo(alt);
    await expect(installBrainWatchHook(d, 'x"; node marker.mjs; "')).rejects.toThrow(/instance_id/);
    expect(readFileSync(hook, 'utf8')).toBe(alt);
  });

  it('ohne .git: nichts geschrieben', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cachly-brain-watch-'));
    ordner.push(d);
    expect((await installBrainWatchHook(d, IID)).result).toBe('skipped-no-git');
  });
});

describe('ohneBrainWatchBlock', () => {
  it('ohne Block: null', () => {
    expect(ohneBrainWatchBlock('#!/bin/sh\necho hi\n')).toBeNull();
  });
  it('nur der Block: leer', () => {
    expect(ohneBrainWatchBlock(ALTER_BRAIN_WATCH_BLOCK + '\n')).toBe('');
  });
});

describe('Werkzeug brain_watch', () => {
  it('ein mitgegebener api_key landet nicht im Hook, die Antwort sagt es', async () => {
    const { d, hook } = repo();
    const ausgabe = String(await handleFedbrainTool(
      'brain_watch',
      { instance_id: IID, project_dir: d, api_key: 'cky_live_mitgegeben' },
      async () => ({}) as unknown as Redis,
      (async () => ({})) as unknown as Parameters<typeof handleFedbrainTool>[3],
    ));
    expect(readFileSync(hook, 'utf8')).not.toContain('cky_live_mitgegeben');
    expect(ausgabe).toContain('was not written into the hook');
    expect(ausgabe).toContain('credentials.json');
  });
});
