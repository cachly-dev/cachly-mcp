/**
 * Befund cli-4 (04.11.2026): Ist `core.hooksPath` gesetzt (Husky, eigene
 * Vorlagen), fuehrt Git `.git/hooks` nicht mehr aus. setup schrieb den Hook
 * trotzdem dorthin und meldete Erfolg — kein Commit wurde je gelernt.
 * Hier mit echten Repos: git init, git config, dann installieren.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitHookOrdner, installClsPostCommitHook } from '../cls-hook.js';

let ordner: string[] = [];
afterEach(() => { for (const o of ordner) rmSync(o, { recursive: true, force: true }); ordner = []; });

function repo(): string {
  const p = mkdtempSync(join(tmpdir(), 'cachly-hookspath-'));
  ordner.push(p);
  execFileSync('git', ['init', '-q'], { cwd: p });
  return p;
}
const git = (p: string, ...a: string[]) => execFileSync('git', a, { cwd: p, encoding: 'utf8' });

describe('gitHookOrdner / installClsPostCommitHook mit core.hooksPath', () => {
  it('ohne core.hooksPath: wie bisher .git/hooks', async () => {
    const p = repo();
    expect(gitHookOrdner(p).replace(/\\/g, '/')).toBe(join(p, '.git', 'hooks').replace(/\\/g, '/'));
    expect(await installClsPostCommitHook(p, 'inst-1')).toBe('written');
    expect(existsSync(join(p, '.git', 'hooks', 'post-commit'))).toBe(true);
  });

  it('eigener Ordner (core.hooksPath = githooks): der Hook landet dort, nicht in .git/hooks', async () => {
    const p = repo();
    git(p, 'config', 'core.hooksPath', 'githooks');
    expect(await installClsPostCommitHook(p, 'inst-1')).toBe('written');
    expect(readFileSync(join(p, 'githooks', 'post-commit'), 'utf8')).toContain('cachly CLS');
    expect(existsSync(join(p, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('Husky 9 (core.hooksPath = .husky/_): der Hook kommt nach .husky/, ein vorhandener bleibt erhalten', async () => {
    const p = repo();
    mkdirSync(join(p, '.husky', '_'), { recursive: true });
    writeFileSync(join(p, '.husky', 'post-commit'), 'npm run notify\n');
    git(p, 'config', 'core.hooksPath', '.husky/_');
    expect(await installClsPostCommitHook(p, 'inst-1')).toBe('appended');
    const text = readFileSync(join(p, '.husky', 'post-commit'), 'utf8');
    expect(text.startsWith('npm run notify')).toBe(true);
    expect(text).toContain('cachly CLS');
    expect(existsSync(join(p, '.husky', '_', 'post-commit'))).toBe(false);
  });

  it('Git-Arbeitsbaum (.git ist eine Datei): kein Hook im geteilten Ordner des Haupt-Repos', () => {
    const haupt = repo();
    writeFileSync(join(haupt, 'a.txt'), 'x');
    git(haupt, 'add', 'a.txt');
    git(haupt, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    const baum = join(mkdtempSync(join(tmpdir(), 'cachly-baum-')), 'wt');
    ordner.push(join(baum, '..'));
    git(haupt, 'worktree', 'add', '-q', baum);
    expect(gitHookOrdner(baum).replace(/\\/g, '/')).toBe(join(baum, '.git', 'hooks').replace(/\\/g, '/'));
  });
});
