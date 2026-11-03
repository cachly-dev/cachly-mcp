/**
 * Was ein Mensch beim Durchlauf von `setup`/`autopilot` im Terminal sieht.
 *
 * Anlass (03.11.2026): Durchlauf von `setup --yes` (0.10.225) in einem
 * frischen Testprojekt mit 3 Commits, fuer die Einrichtungsanleitung. Gesehen:
 *   - "✓ 0 lessons extracted from git history" — in Wahrheit war der Import
 *     mit "Invalid revision range" abgebrochen (Startpunkt eines ANDEREN
 *     Projekts, weil der Schluessel nur 24 Zeichen des Pfads nahm).
 *   - "Top hit: **docker:layer-cache** — 📊 3 of 6 backed by evidence …" —
 *     der Belegsatz statt der Lektion, dazu nackte Sternchen.
 *   - "✅ Written: ~/.claude/mcp.json (global — works in every project)" —
 *     Claude Code liest diese Datei nicht; der Schluessel lag darin im Klartext.
 *   - Ein Kasten "Level: Mid Dev ⚡", ein zweiter mit abgeschnittenem Markdown
 *     und "✅ 100% tls:cert-expiry" fuer ein Projekt ohne TLS.
 *   - Die deutsche Protokollzeile "[aussetzer] bedeutung-abbruch: …".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTopHit, fuersTerminal, renderFirstRecallProof } from '../first-recall-proof.js';
import { alterStartpunktSchluessel, startpunktSchluessel } from '../git-startpunkt.js';

const index = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
const fedbrain = readFileSync(resolve(__dirname, '..', 'handlers', 'fedbrain.ts'), 'utf8');
const setupStart = index.indexOf("process.argv[2] === 'autosetup'");
const setupBlock = index.slice(setupStart, index.indexOf('// ── CLI: cachly-mcp index', setupStart));
/** Nur was gedruckt wird — die Kommentare duerfen die alten Texte zitieren. */
const gedruckt = setupBlock.split('\n').filter((z) => /console\.(log|error)\(|process\.stdout\.write\(/.test(z)).join('\n');

describe('Startpunkt von brain_from_git je Ordner', () => {
  const a = 'C:\\Users\\alice\\Documents\\GitHub\\shop-api';
  const b = 'C:\\Users\\alice\\Documents\\GitHub\\billing';

  it('der alte Schluessel war fuer alle Ordner mit gleichen 24 Anfangszeichen derselbe', () => {
    expect(alterStartpunktSchluessel(a)).toBe(alterStartpunktSchluessel(b));
  });

  it('der neue Schluessel unterscheidet sie', () => {
    expect(startpunktSchluessel(a)).not.toBe(startpunktSchluessel(b));
    expect(startpunktSchluessel(a)).toBe(startpunktSchluessel(a));
    expect(startpunktSchluessel(a)).toMatch(/^cachly:brain_from_git:last_sha:[0-9a-f]{32}$/);
  });

  it('brain_from_git schreibt den neuen Schluessel und prueft einen gemerkten Commit, bevor es ihn nutzt', () => {
    const fall = fedbrain.slice(fedbrain.indexOf("case 'brain_from_git'"));
    expect(fall).toContain('const lastShaKey = startpunktSchluessel(repoDir)');
    expect(fall).toMatch(/gitLesen\(repoDir, \['cat-file', '-e', `\$\{lastSha\}\^\{commit\}`\]\)/);
    expect(fall).toMatch(/redis\.set\(lastShaKey, commits\[0\]\.sha/);
  });
});

describe('Erster Treffer im Terminal', () => {
  const recall = [
    '🧠 **Smart Recall** for: _"docker build slow"_',
    '',
    '> 📊 3 of 6 backed by evidence (at least one matching word, close meaning or a graph link). The rest are only the nearest entries, not evidence.',
    '',
    '**💡 docker:layer-cache** _(BM25: 1.00)_',
    '📖 **Docker layer cache** — copy manifests first',
    '> Copy package manifests and install deps BEFORE copying the rest of the source',
  ].join('\n');

  it('nimmt die Vorschau der Lektion, nicht den Belegsatz davor', () => {
    expect(extractTopHit(recall)).toEqual({
      topic: 'docker:layer-cache',
      what: 'Copy package manifests and install deps BEFORE copying the rest of the source',
    });
  });

  it('erfindet nichts, wenn kein Treffer im Text steht', () => {
    expect(extractTopHit('> 📊 0 of 0 backed by evidence')).toBeNull();
    expect(extractTopHit('')).toBeNull();
  });

  it('druckt keine Markdown-Sternchen ins Terminal', () => {
    expect(renderFirstRecallProof('docker:layer-cache', 'x')).not.toContain('**');
    expect(fuersTerminal('🎯 **Proof** — `smart_recall`')).toBe('🎯 Proof — smart_recall');
  });
});

describe('setup verspricht nur, was stimmt', () => {
  it('schreibt kein ~/.claude/mcp.json mehr und behauptet nicht "works in every project"', () => {
    expect(setupBlock.length).toBeGreaterThan(1000);
    expect(gedruckt).not.toContain('global — works in every project');
    expect(setupBlock).not.toMatch(/writeFile\(globalClaudePath/);
  });

  it('kein erfundenes Level, kein abgeschnittener brain_predict-Kasten', () => {
    expect(gedruckt).not.toContain('Level: ');
    expect(gedruckt).not.toContain('Brain Risk Preview');
    expect(setupBlock).not.toContain("handleTool('brain_predict'");
  });

  it('legt das Brain neben den Schluessel, damit init ohne Argumente es findet', () => {
    expect(setupBlock).toMatch(/saveApiKey\(token\);\s*\n(\s*\/\/.*\n)*\s*saveInstanceId\(instance\.id, \{ apiKey: token \}\);/);
    const initBlock = index.slice(index.indexOf('Zero-arg path'), index.indexOf('Zero-arg path') + 1200);
    expect(initBlock.indexOf('readSavedApiKey()')).toBeGreaterThan(-1);
    expect(initBlock.indexOf('readSavedApiKey()')).toBeLessThan(initBlock.indexOf("'.claude', 'mcp.json'"));
  });

  it('ein abgebrochener Git-Import heisst "skipped", nicht "✓ 0 lessons"', () => {
    expect(setupBlock).toMatch(/if \(gitResult\.startsWith\('❌'\)\)/);
  });

  it('der naechste Schritt ist die Probe-Frage an die KI, mit Link zur Anleitung', () => {
    expect(setupBlock).toContain('What does my cachly Brain know about this project?');
    expect(setupBlock).toContain("cachlyUrl('/docs/setup', cliSource)");
  });

  it('interne Protokollzeilen bleiben im Terminal-Assistenten leise', () => {
    expect(setupBlock.slice(0, 600)).toContain('aussetzerLeise()');
  });
});
