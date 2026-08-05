import { describe, it, expect } from 'vitest';
import { formatProvenance, formatContextBlock, runAmbient, type AmbientDeps } from '../ambient-cli.js';
import { emptyMemory, type LessonCandidate, type RecallMemory } from '../ambient-recall.js';

function lesson(over: Partial<LessonCandidate> = {}): LessonCandidate {
  return {
    id: 'l1',
    summary: 'Backup-Env liegt in der rsync-Zone und wird beim Deploy geloescht',
    confidence: 0.95,
    score: 0.95,
    ...over,
  };
}

describe('formatProvenance — der Beleg', () => {
  it('nennt Datum, Datei und Ausgang', () => {
    const p = formatProvenance(
      lesson({ learnedAt: '2026-07-24T10:00:00Z', files: ['infra/backup.sh'], outcome: 'failure' }),
    );
    expect(p).toContain('24.07.');
    expect(p).toContain('infra/backup.sh');
    expect(p).toContain('schief');
  });

  it('bleibt leer, wenn es nichts zu belegen gibt', () => {
    expect(formatProvenance(lesson())).toBe('');
  });

  it('zeigt hoechstens zwei Dateien und zaehlt den Rest', () => {
    const p = formatProvenance(lesson({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }));
    expect(p).toContain('a.ts, b.ts');
    expect(p).toContain('(+2)');
    expect(p).not.toContain('c.ts');
  });

  it('ignoriert ein unlesbares Datum, statt zu scheitern', () => {
    expect(formatProvenance(lesson({ learnedAt: 'keine-zeit' }))).toBe('');
  });
});

describe('formatContextBlock mit Beleg', () => {
  it('haengt den Beleg unter die Lektion', () => {
    const out = formatContextBlock([
      lesson({ learnedAt: '2026-07-24T10:00:00Z', files: ['infra/backup.sh'], outcome: 'failure' }),
      lesson({ id: 'l2', summary: 'Zweite Lektion' }),
    ]);
    expect(out).toContain('- Backup-Env');
    expect(out).toContain('↳');
    expect(out).toContain('24.07.');
    // Lektion ohne Beleg bekommt keine leere Zeile
    expect(out).not.toContain('↳ \n');
  });
});

const PROMPT = 'deploy the api and run the migration on prod';
function deps(over: Partial<AmbientDeps> = {}): AmbientDeps {
  return {
    recall: async () => [lesson()],
    ...over,
  } as AmbientDeps;
}
const payload = (prompt: string) =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt });

describe('runAmbient — Gedaechtnis verdrahtet', () => {
  it('wiederholt dieselbe Lektion nicht sofort', async () => {
    let mem: RecallMemory = emptyMemory();
    const d = deps({ loadMemory: () => mem, saveMemory: (m) => { mem = m; } });

    const erste = await runAmbient(payload(PROMPT), d);
    expect(erste).toContain('additionalContext');

    const zweite = await runAmbient(payload(PROMPT), d);
    expect(zweite).toBe('');
  });

  it('bleibt ohne Gedaechtnis-Deps zustandslos (Rueckwaertskompatibilitaet)', async () => {
    const d = deps();
    const a = await runAmbient(payload(PROMPT), d);
    const b = await runAmbient(payload(PROMPT), d);
    expect(a).not.toBe('');
    expect(b).toBe(a);
  });

  it('laesst einen Schreibfehler im Gedaechtnis den Turn nicht stoppen', async () => {
    const d = deps({
      loadMemory: () => emptyMemory(),
      saveMemory: () => { throw new Error('Platte voll'); },
    });
    await expect(runAmbient(payload(PROMPT), d)).resolves.toContain('additionalContext');
  });
});
