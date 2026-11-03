import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  recallQueryFor,
  stopObservation,
  buildHookOutput,
  type HookPayload,
} from '../ambient-cli.js';

describe('parseHookPayload', () => {
  it('parses valid JSON objects', () => {
    expect(parseHookPayload('{"prompt":"x"}')).toEqual({ prompt: 'x' });
  });
  it('returns null for empty / malformed / non-object input', () => {
    expect(parseHookPayload('')).toBeNull();
    expect(parseHookPayload('   ')).toBeNull();
    expect(parseHookPayload('not json')).toBeNull();
    expect(parseHookPayload('42')).toBeNull();
    expect(parseHookPayload('"a string"')).toBeNull();
  });
});

describe('recallQueryFor', () => {
  it('returns the prompt for a substantive UserPromptSubmit', () => {
    const p: HookPayload = { hook_event_name: 'UserPromptSubmit', prompt: 'why does the deploy job fail on migrate?' };
    expect(recallQueryFor(p)).toContain('deploy job fail');
  });
  it('skips only empty prompts — short ones are left to the core gate (two content words)', () => {
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: '' })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: '   ' })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: 'Wo laeuft Whisper?' })).toBe('Wo laeuft Whisper?');
  });
  it('SessionStart needs no query — it briefs from the whole stock', () => {
    expect(recallQueryFor({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull();
  });
  it('defaults an unlabeled event to UserPromptSubmit semantics', () => {
    expect(recallQueryFor({ prompt: 'refactor the auth provider redirect loop' })).toContain('redirect loop');
  });

  it('builds a file-scoped query for PreToolUse on file-mutating tools', () => {
    const q = recallQueryFor({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/api/internal/handler/auth.go' },
    });
    expect(q).toContain('/repo/api/internal/handler/auth.go');
  });

  it('PreToolUse drops the cwd prefix so "users"/"documents" never count as matches', () => {
    const q = recallQueryFor({
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      cwd: 'C:\\Users\\heinr\\Documents\\repo',
      tool_input: { file_path: 'C:\\Users\\heinr\\Documents\\repo\\infra\\backup.sh' },
    });
    expect(q).toBe('infra/backup.sh');
  });

  it('skips PreToolUse for non-file tools and missing file_path', () => {
    expect(recallQueryFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} })).toBeNull();
  });

  it('never recalls on Stop', () => {
    expect(recallQueryFor({ hook_event_name: 'Stop', last_assistant_message: 'fixed the bug in x' })).toBeNull();
  });
});

describe('stopObservation (auto-learn fix signal)', () => {
  const fixMsg =
    'The root cause was the RefreshErrorGuard wrapping the whole app; the redirect loop is now fixed. ' +
    'I scoped the guard to protected routes only and verified the public landing no longer bounces to Keycloak.';

  it('extracts a success observation from a clear fix message', () => {
    const obs = stopObservation({ hook_event_name: 'Stop', last_assistant_message: fixMsg });
    expect(obs).not.toBeNull();
    expect(obs!.outcome).toBe('success');
    expect(obs!.action.length).toBeLessThanOrEqual(200);
    expect(obs!.details).toContain('root cause');
  });

  // 03.11.2026 plugin-stop-failure-stored-as-success
  it('speichert ein Scheitern nicht als Erfolg', () => {
    const scheitern =
      'Unfortunately I could not get this fixed. The failing migration still deadlocks and the tests are still red; root cause unknown, I gave up.';
    expect(stopObservation({ hook_event_name: 'Stop', last_assistant_message: scheitern })).toBeNull();
    const deutsch =
      'Ich habe den Fehler leider nicht behoben. Die Ursache ist weiterhin unklar und die Tests sind noch rot, deshalb höre ich hier auf.';
    expect(stopObservation({ hook_event_name: 'Stop', last_assistant_message: deutsch })).toBeNull();
  });

  it('"root cause" allein ist kein Loesungssignal', () => {
    const msg = 'I looked at the root cause candidates in the scheduler module and listed them below for the next person to check.';
    expect(stopObservation({ hook_event_name: 'Stop', last_assistant_message: msg })).toBeNull();
  });

  it('nimmt das Thema aus der Zeile mit dem Loesungssignal, nicht aus der Floskel', () => {
    const msg = 'Ich habe den Fehler gesucht und mehrere Dateien gelesen.\nThe bug was a missing await in queue.ts which made the worker exit early on every run.';
    const obs = stopObservation({ hook_event_name: 'Stop', last_assistant_message: msg })!;
    expect(obs.action.startsWith('The bug was')).toBe(true);
  });

  it('returns null for short or signal-free messages (no brain spam)', () => {
    expect(stopObservation({ hook_event_name: 'Stop', last_assistant_message: 'Done.' })).toBeNull();
    expect(
      stopObservation({
        hook_event_name: 'Stop',
        last_assistant_message:
          'Here is a summary of the files in the repository and what each module does, as requested. The layout follows the standard structure.',
      }),
    ).toBeNull();
    expect(stopObservation({ hook_event_name: 'Stop' })).toBeNull();
  });
});

describe('buildHookOutput', () => {
  it('wraps context in the hookSpecificOutput shape', () => {
    const out = JSON.parse(buildHookOutput('UserPromptSubmit', 'ctx'));
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toBe('ctx');
  });
  it('emits nothing for empty context', () => {
    expect(buildHookOutput('SessionStart', '')).toBe('');
  });
});

