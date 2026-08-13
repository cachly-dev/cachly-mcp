/**
 * Abnahme GROW-038 — session_end lernt aus dem Begruendungstext (%b) statt nur
 * aus der Betreffzeile (%s), verwirft Ueberschriften ohne Substanz, und die
 * Datei-Zusammengehoerigkeit eines Commits wandert als co-occurs-Kante in den
 * Graphen statt als "Files changed in ..."-Lektion.
 *
 * Deckt die sechs Abnahmepunkte aus dem Task-Pack (ABNAHME 2-7):
 *   2. Betreff + 800-Zeichen-Koerper -> Lektion, what_worked enthaelt den Koerper.
 *   3. Nur Betreff, kein Koerper -> keine Lektion.
 *   4. Mehrzeiliger Koerper landet vollstaendig in einem Feld, nicht zerissen.
 *   5. Keine Lektion mehr mit "Files changed in".
 *   6. Zwei im selben Commit geaenderte Dateien bekommen eine co-occurs-Kante.
 *   7. Der Bestand an auto:changed-Lektionen waechst durch session_end nicht mehr.
 *
 * Nutzt einen ECHTEN temporaeren Git-Ordner statt eines child_process-Mocks —
 * das beweist das tatsaechliche execSync-Parsing (Format-String, ENDE-Trennung)
 * end-to-end, statt es nur nachzurechnen (Regel: Verhalten wird ausgefuehrt).
 *
 * Run: npx vitest run src/__tests__/GROW-038.ambient-git-body.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { handleBrainTool } from '../handlers/brain.js';
import { ckgSlug } from '../ckg.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock (gleiche Form wie brain-flow.test.ts) ───────────────
class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) { if (this.store.delete(k)) n++; }
    return n;
  }

  async expire(_key: string, _ttl: number): Promise<number> { return 1; }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values.slice().reverse());
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start < 0 ? list.length + start : start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start < 0 ? list.length + start : start, end));
    return 'OK';
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  _store() { return this.store; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const INSTANCE = 'test-grow038-instance';
const NO_FETCH = (async () => { throw new Error('no fetch'); }) as unknown as Parameters<typeof handleBrainTool>[3];

function makeGetConn(redis: MockRedis) {
  return (async (_id: string) => redis as unknown as Redis);
}

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cachly-grow038-'));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'grow038-test@example.invalid']);
  git(dir, ['config', 'user.name', 'GROW-038 Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

/** Legt die angegebenen Dateien an und committet sie mit Betreff + optionalem Koerper. */
function commitFiles(repoDir: string, files: Record<string, string>, subject: string, body?: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    git(repoDir, ['add', rel]);
  }
  const message = body ? `${subject}\n\n${body}` : subject;
  git(repoDir, ['commit', '--quiet', '-m', message]);
  return git(repoDir, ['rev-parse', 'HEAD']).trim();
}

async function startSession(redis: MockRedis, startedAgoMs = 5 * 60_000): Promise<void> {
  await redis.set('cachly:session:current', JSON.stringify({ started: new Date(Date.now() - startedAgoMs).toISOString() }));
}

async function endSession(redis: MockRedis, workspacePath: string, filesChanged: string[] = []): Promise<string> {
  const result = await handleBrainTool(
    'session_end',
    { instance_id: INSTANCE, summary: 'GROW-038 Testlauf.', workspace_path: workspacePath, files_changed: filesChanged },
    makeGetConn(redis),
    NO_FETCH,
  );
  return String(result);
}

function lessonKeysWithPrefix(redis: MockRedis, prefix: string): string[] {
  return [...redis._store().keys()].filter(k => k.startsWith(`cachly:lesson:best:${prefix}`));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GROW-038 — Ambient Git Learning liest den Begruendungstext statt nur die Ueberschrift', () => {
  let redis: MockRedis;
  const createdDirs: string[] = [];

  beforeEach(() => {
    redis = new MockRedis();
  });

  afterEach(() => {
    while (createdDirs.length > 0) {
      const dir = createdDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function repo(): string {
    const dir = initRepo();
    createdDirs.push(dir);
    return dir;
  }

  // ── ABNAHME 2 ─────────────────────────────────────────────────────────────
  it('Commit mit Betreff und 800-Zeichen-Koerper erzeugt eine Lektion, deren what_worked den Koerper enthaelt', async () => {
    const dir = repo();
    const marker = 'MESSWERT-MARKE-4711';
    // 20 Wiederholungen ergeben 981 Zeichen. Mit 16 waren es 789 — der Test
    // scheiterte damit an seiner EIGENEN Vorbedingung, bevor der Produktcode
    // ueberhaupt lief. Gerechnet: 19 Zeichen Marke + 2 + 47 je Satz.
    const longBody = `${marker}: ` + 'Ursache war eine falsche Zeitzone im Vergleich. '.repeat(20);
    expect(longBody.length).toBeGreaterThan(800);
    commitFiles(dir, { 'a.txt': 'x' }, 'fix: Zeitzonenfehler im Abgleich behoben', longBody);

    await startSession(redis);
    await endSession(redis, dir);

    const keys = lessonKeysWithPrefix(redis, 'git:');
    expect(keys).toHaveLength(1);
    const lesson = JSON.parse(redis._store().get(keys[0]!)!) as { what_worked: string };
    expect(lesson.what_worked).toContain('fix: Zeitzonenfehler im Abgleich behoben');
    expect(lesson.what_worked).toContain(marker);
  });

  // ── ABNAHME 3 ─────────────────────────────────────────────────────────────
  it('Commit nur mit Betreff (kein Koerper) erzeugt KEINE Lektion', async () => {
    const dir = repo();
    commitFiles(dir, { 'b.txt': 'x' }, 'fix: kleine Korrektur ohne weitere Erklaerung');

    await startSession(redis);
    await endSession(redis, dir);

    expect(lessonKeysWithPrefix(redis, 'git:')).toHaveLength(0);
  });

  // ── ABNAHME 4 ─────────────────────────────────────────────────────────────
  it('Commit mit mehrzeiligem Koerper wird korrekt getrennt — der Koerper landet vollstaendig in einem Feld', async () => {
    const dir = repo();
    const body = [
      'ERSTE-ZEILE-9001: Ursache war ein falscher Zeitstempel-Vergleich.',
      'ZWEITE-ZEILE-9002: Der Vergleich lief gegen Mikrosekunden statt Sekunden.',
      '',
      'LETZTE-ZEILE-9003: Fix ersetzt den Vergleich durch eine Ganzzahl-Differenz.',
    ].join('\n');
    expect(body.length).toBeGreaterThan(120);
    commitFiles(dir, { 'c.txt': 'x' }, 'fix: Zeitstempel-Vergleich repariert', body);
    // Ein zweiter, unmittelbar folgender Commit ohne Koerper — beweist, dass
    // das Trennen an '|||ENDE' den ersten Koerper nicht in den zweiten Eintrag
    // durchsickern laesst und nicht als eigene (falsche) Lektion auftaucht.
    commitFiles(dir, { 'd.txt': 'x' }, 'chore: Formatierung angepasst');

    await startSession(redis);
    await endSession(redis, dir);

    const keys = lessonKeysWithPrefix(redis, 'git:');
    expect(keys).toHaveLength(1); // der Koerper-lose Commit erzeugt keine Lektion (ABNAHME 3)
    const lesson = JSON.parse(redis._store().get(keys[0]!)!) as { what_worked: string };
    expect(lesson.what_worked).toContain('ERSTE-ZEILE-9001');
    expect(lesson.what_worked).toContain('ZWEITE-ZEILE-9002');
    expect(lesson.what_worked).toContain('LETZTE-ZEILE-9003');
    // Der Koerper bleibt EIN zusammenhaengendes Stueck: zwischen der ersten und
    // der letzten Marke liegt der volle Text, nicht abgerissen nach Zeile 1.
    const start = lesson.what_worked.indexOf('ERSTE-ZEILE-9001');
    const end = lesson.what_worked.indexOf('LETZTE-ZEILE-9003');
    expect(end).toBeGreaterThan(start);
    expect(lesson.what_worked.slice(start, end)).toContain('ZWEITE-ZEILE-9002');
  });

  // ── ABNAHME 5 ─────────────────────────────────────────────────────────────
  it('Es entsteht keine Lektion mehr mit "Files changed in"', async () => {
    const dir = repo();
    commitFiles(dir, { 'e.txt': 'x', 'f.txt': 'y' }, 'feat: zwei Dateien in einem Commit');

    await startSession(redis);
    await endSession(redis, dir, ['sdk/mcp/e.txt', 'sdk/mcp/f.txt']);

    expect(lessonKeysWithPrefix(redis, 'auto:changed:')).toHaveLength(0);
    for (const raw of redis._store().values()) {
      expect(raw).not.toContain('Files changed in');
    }
  });

  // ── ABNAHME 6 ─────────────────────────────────────────────────────────────
  it('Zwei im selben Commit geaenderte Dateien haben danach eine co-occurs-Kante zwischeneinander', async () => {
    const dir = repo();
    // Bewusst OHNE Koerper: beweist, dass die co-occurs-Kante unabhaengig
    // davon entsteht, ob der Commit ueberhaupt eine Lektion erzeugt.
    commitFiles(dir, { 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n' }, 'refactor: a und b gemeinsam angepasst');

    await startSession(redis);
    await endSession(redis, dir);

    expect(lessonKeysWithPrefix(redis, 'git:')).toHaveLength(0); // kein Koerper -> keine Lektion (ABNAHME 3)

    const idA = `file:${ckgSlug('src/a.ts')}`;
    const idB = `file:${ckgSlug('src/b.ts')}`;
    const edgeAB = await redis.get(`cachly:ckg:edge:${idA}:co-occurs:${idB}`);
    const edgeBA = await redis.get(`cachly:ckg:edge:${idB}:co-occurs:${idA}`);
    expect(edgeAB).not.toBeNull();
    expect(edgeBA).not.toBeNull();
    expect((JSON.parse(edgeAB!) as { edgeType: string }).edgeType).toBe('co-occurs');
    expect((JSON.parse(edgeBA!) as { edgeType: string }).edgeType).toBe('co-occurs');
  });

  // ── ABNAHME 7 ─────────────────────────────────────────────────────────────
  it('Der Bestand an auto:changed-Lektionen waechst durch ein echtes session_end nicht mehr', async () => {
    const dir = repo();
    // Ein Bestands-Eintrag von FRUEHER simuliert eine bereits vorhandene
    // auto:changed-Lektion (Alt-Verhalten vor GROW-038). Sie darf nicht
    // geloescht, aber auch nicht neu geschrieben oder verlaengert werden.
    const bestandsKey = 'cachly:lesson:best:auto:changed:sdk-mcp';
    const bestandsWert = JSON.stringify({
      topic: 'auto:changed:sdk-mcp', outcome: 'success',
      what_worked: 'Files changed in sdk/mcp: sdk/mcp/x.ts', ts: '2020-01-01T00:00:00.000Z',
    });
    await redis.set(bestandsKey, bestandsWert);

    commitFiles(dir, { 'g.txt': 'x' }, 'feat: weitere Aenderung im gleichen Bereich');

    const before = lessonKeysWithPrefix(redis, 'auto:changed:').length;
    await startSession(redis);
    await endSession(redis, dir, ['sdk/mcp/g.txt']);
    const after = lessonKeysWithPrefix(redis, 'auto:changed:').length;

    expect(after).toBe(before);
    // Byte-identisch: der Alteintrag wurde nicht neu geschrieben (kein TTL-Reset).
    expect(redis._store().get(bestandsKey)).toBe(bestandsWert);
  });
});
