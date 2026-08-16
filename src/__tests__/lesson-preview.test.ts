import { describe, it, expect } from 'vitest';
import {
  trimTo,
  factsOf,
  warningOf,
  lessonPreviewLines,
  lessonPreview,
  type PreviewLesson,
} from '../lesson-preview.js';

/**
 * The regression these tests exist for (2026-08-16, measured, not hypothetical).
 *
 * This is the real lesson, shortened only where it does not matter. A reader
 * needed the WireGuard address; it sits at character 323 of what_worked, the
 * briefing cut at 100, and the warning that would have prevented the mistake
 * lives in what_failed — a field no briefing surface rendered, because the
 * lesson's outcome is "success".
 */
const NODE4: PreviewLesson = {
  topic: 'node4:einrichtung-contabo-und-fallen',
  outcome: 'success',
  severity: 'critical',
  what_worked:
    'node-4 (Contabo, 169.58.175.157, Lauterbourg FR, 12 Kerne / 48 GB / 400 GB, '
    + '25,29 EUR/Monat) eingerichtet am 13.08.2026: deploy-Benutzer + Schluessel, '
    + 'SSH Port 2222, PermitRootLogin prohibit-password, ufw aktiv. '
    + 'WireGuard-Peer 10.8.0.7 (Endpoint node-1 78.47.24.49:51820).',
  what_failed:
    'DREI FALLEN. (1) 10.8.0.4 ist BELEGT, obwohl es auf Ping nicht antwortet. '
    + 'Ein Ping-Scan als Adressbeleg haette eine Kollision gebaut. '
    + 'Immer `wg show wg0 allowed-ips` auf node-1 lesen.',
  commands: [
    'ssh -i ~/.ssh/cachly-deploy -p 2222 root@169.58.175.157',
    'wg show wg0 allowed-ips',
    'systemctl disable --now ssh.socket && systemctl enable --now ssh.service',
  ],
  file_paths: ['/etc/wireguard/wg0.conf', '/etc/ssh/sshd_config.d/99-cachly.conf'],
};

describe('lesson-preview — the node-4 regression', () => {
  it('the old behaviour loses the address: prose alone cuts before character 323', () => {
    const pos = NODE4.what_worked!.indexOf('10.8.0.7');
    expect(pos).toBeGreaterThan(100); // the premise of the whole bug
    expect(NODE4.what_worked!.slice(0, 100)).not.toContain('10.8.0.7');
  });

  it('surfaces the command that answers the question, even though prose is cut', () => {
    const out = lessonPreview(NODE4);
    expect(out).not.toContain('10.8.0.7'); // prose is still cut — that is fine
    expect(out).toContain('wg show wg0 allowed-ips'); // …because the FACT is shown
  });

  it('shows the warning of a critical lesson even when outcome is success', () => {
    const out = lessonPreview(NODE4);
    expect(NODE4.outcome).toBe('success'); // the exact case that was invisible
    expect(out).toContain('⚠️');
    expect(out).toContain('Ping-Scan');
  });

  it('stays compact: at most three lines for one lesson', () => {
    expect(lessonPreviewLines(NODE4).length).toBeLessThanOrEqual(3);
  });
});

describe('trimTo', () => {
  it('leaves short text untouched and adds no marker', () => {
    expect(trimTo('kurz', 100)).toBe('kurz');
  });

  it('marks a cut so a truncated line cannot pass as complete', () => {
    expect(trimTo('a'.repeat(200), 50)).toMatch(/…$/);
    expect(trimTo('a'.repeat(200), 50).length).toBeLessThanOrEqual(51);
  });

  it('collapses newlines so a multi-line field cannot break the list layout', () => {
    expect(trimTo('eins\n\n  zwei\tdrei', 100)).toBe('eins zwei drei');
  });

  it('prefers a word boundary but never throws away most of the budget', () => {
    expect(trimTo('alpha beta gamma delta', 16)).toBe('alpha beta…');
    // One long word: cutting at the boundary would yield almost nothing,
    // so the hard cut wins.
    expect(trimTo(`x ${'y'.repeat(60)}`, 20)).toMatch(/^x yyy/);
  });

  it('returns empty for a non-positive budget instead of throwing', () => {
    expect(trimTo('irgendwas', 0)).toBe('');
  });
});

describe('factsOf', () => {
  it('puts runnable commands before file paths', () => {
    const f = factsOf(NODE4, 2, 64);
    expect(f[0]).toMatch(/^⌘ /);
    expect(f.some((x) => x.startsWith('▸ '))).toBe(true);
  });

  it('honours the per-kind limit', () => {
    expect(factsOf(NODE4, 1, 64)).toHaveLength(2); // 1 command + 1 path
  });

  it('drops duplicates and blank entries', () => {
    const l: PreviewLesson = {
      topic: 't',
      commands: ['same', 'same', '   ', 'other'],
    };
    expect(factsOf(l, 5, 64)).toEqual(['⌘ same', '⌘ other']);
  });

  it('returns nothing when the lesson has no structured fields', () => {
    expect(factsOf({ topic: 't', what_worked: 'nur prosa' }, 2, 64)).toEqual([]);
  });

  it('trims an over-long command rather than blowing up the line', () => {
    const l: PreviewLesson = { topic: 't', commands: ['x'.repeat(300)] };
    expect(factsOf(l, 1, 40)[0]!.length).toBeLessThanOrEqual(43); // '⌘ ' + 40 + '…'
  });
});

describe('warningOf', () => {
  it('shows for critical regardless of outcome', () => {
    expect(warningOf({ topic: 't', severity: 'critical', outcome: 'success', what_failed: 'pass auf' }, 110))
      .toBe('pass auf');
  });

  it('shows for failure and partial even when not critical', () => {
    for (const outcome of ['failure', 'partial']) {
      expect(warningOf({ topic: 't', outcome, what_failed: 'pass auf' }, 110)).toBe('pass auf');
    }
  });

  it('stays quiet for a non-critical success — that is noise, not a warning', () => {
    expect(warningOf({ topic: 't', severity: 'major', outcome: 'success', what_failed: 'pass auf' }, 110))
      .toBeNull();
  });

  it('stays quiet when the field is empty', () => {
    expect(warningOf({ topic: 't', severity: 'critical', outcome: 'success', what_failed: '  ' }, 110))
      .toBeNull();
  });
});

describe('lessonPreviewLines — layout guarantees', () => {
  it('emits no empty continuation lines for a bare lesson', () => {
    const lines = lessonPreviewLines({ topic: 't', what_worked: 'nur prosa' });
    expect(lines).toEqual(['nur prosa']);
  });

  it('emits nothing at all when the lesson carries no content', () => {
    expect(lessonPreviewLines({ topic: 't' })).toEqual([]);
  });

  it('can be switched back to prose-only, so callers keep control of budget', () => {
    const out = lessonPreview(NODE4, { facts: false, warning: false });
    expect(out.split('\n')).toHaveLength(1);
    expect(out).not.toContain('⌘');
  });

  it('keeps the whole entry bounded — no lesson can flood the briefing', () => {
    const monster: PreviewLesson = {
      topic: 't',
      severity: 'critical',
      outcome: 'success',
      what_worked: 'w'.repeat(5000),
      what_failed: 'f'.repeat(5000),
      commands: Array.from({ length: 50 }, (_, i) => `cmd-${i} ${'z'.repeat(500)}`),
      file_paths: Array.from({ length: 50 }, (_, i) => `/p/${i}/${'z'.repeat(500)}`),
    };
    expect(lessonPreview(monster).length).toBeLessThan(600);
  });
});
