import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  recallQueryFor,
  stopObservation,
  truncateToTokens,
  formatContextBlock,
  buildHookOutput,
  runAmbient,
  CREDIT_FOOTER,
  type HookPayload,
} from '../ambient-cli.js';
import type { LessonCandidate } from '../ambient-recall.js';

const lesson = (over: Partial<LessonCandidate> = {}): LessonCandidate => ({
  id: 'l1',
  summary: 'Always run go build ./... after touching a .go file — unused imports are compile errors.',
  confidence: 0.9,
  score: 0.9,
  ...over,
});

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
  it('skips trivial prompts (returns null before any brain call)', () => {
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: 'ok' })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'UserPromptSubmit', prompt: '' })).toBeNull();
  });
  it('returns a briefing query for SessionStart startup/resume', () => {
    expect(recallQueryFor({ hook_event_name: 'SessionStart', source: 'startup' })).toContain('session start');
  });
  it('skips mid-session SessionStart resumes (compact/clear)', () => {
    expect(recallQueryFor({ hook_event_name: 'SessionStart', source: 'compact' })).toBeNull();
    expect(recallQueryFor({ hook_event_name: 'SessionStart', source: 'clear' })).toBeNull();
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

describe('truncateToTokens', () => {
  it('leaves short text untouched', () => {
    expect(truncateToTokens('short', 100)).toBe('short');
  });
  it('caps long text within the token budget and marks it', () => {
    const long = 'word '.repeat(500);
    const out = truncateToTokens(long, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20 * 4 + 1);
  });
});

describe('formatContextBlock', () => {
  it('bullets multiple short lessons under a title', () => {
    const out = formatContextBlock([lesson({ id: 'a', summary: 'A' }), lesson({ id: 'b', summary: 'B' })]);
    expect(out).toContain('Relevant memory');
    expect(out).toContain('- A');
    expect(out).toContain('- B');
  });
  it('injects a single pre-formatted briefing verbatim (no bullet wrapping)', () => {
    const briefing = '🧠 Smart Recall\n> Brain saved you here\n- lesson one';
    expect(formatContextBlock([lesson({ summary: briefing })])).toBe(briefing);
  });
  it('returns empty for no lessons', () => {
    expect(formatContextBlock([])).toBe('');
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

describe('runAmbient (end-to-end, injected recall)', () => {
  const okRecall = async () => [lesson()];
  const failRecall = async () => { throw new Error('brain down'); };

  it('injects gated context for a substantive prompt', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing migrate step in CI' }),
      { recall: okRecall },
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('go build');
  });

  it('skips trivial prompts without ever calling recall', async () => {
    let called = false;
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks!' }),
      { recall: async () => { called = true; return [lesson()]; } },
    );
    expect(out).toBe('');
    expect(called).toBe(false);
  });

  it('emits nothing on malformed stdin', async () => {
    expect(await runAmbient('not json', { recall: okRecall })).toBe('');
  });

  it('emits nothing when recall throws (never blocks the turn)', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'deploy the api to production now' }),
      { recall: failRecall },
    );
    expect(out).toBe('');
  });

  it('emits nothing when recall returns no candidates', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'why is the build cache cold?' }),
      { recall: async () => [] },
    );
    expect(out).toBe('');
  });

  it('drops candidates below the gate (low score) → no injection', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'debug the auth token refresh error' }),
      { recall: async () => [lesson({ score: 0.1, confidence: 0.1 })] },
    );
    expect(out).toBe('');
  });

  it('recalls a briefing for SessionStart and injects it', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      { recall: async () => [lesson({ summary: 'Line one\nLine two briefing' })] },
    );
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(parsed.hookSpecificOutput.additionalContext).toContain('briefing');
  });

  it('honours the timeout budget (slow recall → nothing injected)', async () => {
    const slow = () => new Promise<LessonCandidate[]>((res) => setTimeout(() => res([lesson()]), 50));
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'refactor the migration runner logic' }),
      { recall: slow, timeoutMs: 5 },
    );
    expect(out).toBe('');
  });

  it('skips recall entirely while auto-backoff is active (§6.3 guardrail 3)', async () => {
    let recalled = false;
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'debug the failing deploy pipeline' }),
      { recall: async () => { recalled = true; return [lesson()]; }, backoff: () => true },
    );
    expect(out).toBe('');
    expect(recalled).toBe(false);
  });

  it('a crashing backoff probe does not disable recall', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'debug the failing deploy pipeline' }),
      { recall: okRecall, backoff: () => { throw new Error('ledger broken'); } },
    );
    expect(out).not.toBe('');
  });

  it('books injected tokens via onInject, including the credit footer cost', async () => {
    let booked = 0;
    let event = '';
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the race in the cache invalidation' }),
      { recall: okRecall, onInject: (t, e) => { booked = t; event = e; } },
    );
    const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain(CREDIT_FOOTER);
    expect(event).toBe('UserPromptSubmit');
    expect(booked).toBeGreaterThanOrEqual(Math.ceil(ctx.trim().length / 4) - 1);
  });

  it('injects file-scoped context on PreToolUse (with footer), no footer on SessionStart', async () => {
    const pre = await runAmbient(
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/repo/web/components/auth-provider.tsx' },
      }),
      { recall: okRecall },
    );
    expect(JSON.parse(pre).hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(JSON.parse(pre).hookSpecificOutput.additionalContext).toContain(CREDIT_FOOTER);

    const session = await runAmbient(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      { recall: async () => [lesson({ summary: 'Line one\nLine two briefing' })] },
    );
    expect(JSON.parse(session).hookSpecificOutput.additionalContext).not.toContain(CREDIT_FOOTER);
  });

  it('emits nothing for Stop payloads (learning is the CLI wiring, not injection)', async () => {
    const out = await runAmbient(
      JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'fixed everything, root cause found' }),
      { recall: okRecall },
    );
    expect(out).toBe('');
  });
});
