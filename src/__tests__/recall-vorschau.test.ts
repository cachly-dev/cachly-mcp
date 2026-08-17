import { describe, it, expect } from 'vitest';
import { recallVorschau } from '../handlers/brain.js';

/**
 * The regression: smart_recall previewed `r.content` — the RAW JSON of the
 * stored record — sliced at 300/400 characters. The reader got field names
 * instead of facts, and the two most useful fields (`what_failed`, `commands`)
 * never appeared because they sit far past the cut.
 *
 * smart_recall is the call this project mandates before every task, so this is
 * the worst place in the product for that. These tests hold the fix in place.
 */
const LESSON_KEY = 'cachly:lesson:best:node4:einrichtung-contabo-und-fallen';
const LESSON = {
  topic: 'node4:einrichtung-contabo-und-fallen',
  outcome: 'success',
  severity: 'critical',
  // In Originallaenge belassen (rund 700 Zeichen). Eine gekuerzte Fixture
  // wuerde den Fehler verstecken: bei kurzem Text passt der entscheidende
  // Befehl zufaellig noch in die 400 Zeichen, und der Test bewiese nichts.
  what_worked:
    'node-4 (Contabo, 169.58.175.157, Lauterbourg FR, 12 Kerne / 48 GB / 400 GB, '
    + '25,29 EUR/Monat) eingerichtet am 13.08.2026: deploy-Benutzer + Schluessel, '
    + 'SSH Port 2222, PermitRootLogin prohibit-password, PasswordAuthentication no, '
    + 'ufw aktiv (nur 2222 + 9100 aus 10.8.0.0/24), fail2ban mit ignoreip 10.8.0.0/24. '
    + 'WireGuard-Peer 10.8.0.7 (Endpoint node-1 78.47.24.49:51820). Docker 29.7.2, '
    + 'drei Actions-Runner v2.336.0 in /opt/actions-runner-{org,2,kanzlei} als root mit '
    + 'RUNNER_ALLOW_RUNASROOT=1. node-exporter im Host-Netz an 10.8.0.7:9100 (NICHT per -p, '
    + 'sonst umgeht Docker die ufw).',
  what_failed: 'Ein Ping-Scan als Adressbeleg haette eine Kollision gebaut. '
    + 'Immer `wg show wg0 allowed-ips` auf node-1 lesen.',
  commands: ['wg show wg0 allowed-ips', 'ssh -i ~/.ssh/cachly-deploy -p 2222 root@169.58.175.157'],
  file_paths: ['/etc/wireguard/wg0.conf'],
};
const LESSON_JSON = JSON.stringify(LESSON);

describe('recallVorschau — a lesson is rendered as a lesson, not as JSON', () => {
  it('never leaks JSON syntax into the preview', () => {
    const out = recallVorschau(LESSON_KEY, LESSON_JSON, 400).join('\n');
    expect(out).not.toContain('{"topic"');
    expect(out).not.toContain('"what_worked":');
    expect(out).not.toContain('outcome":"success');
  });

  it('the old behaviour wasted the budget on field names', () => {
    // The premise, so nobody "simplifies" this back.
    const alt = LESSON_JSON.slice(0, 400);
    expect(alt).toContain('{"topic"');
    expect(alt).not.toContain('wg show wg0 allowed-ips');
  });

  it('surfaces the command that answers the question', () => {
    const out = recallVorschau(LESSON_KEY, LESSON_JSON, 400).join('\n');
    expect(out).toContain('wg show wg0 allowed-ips');
  });

  it('surfaces the warning of a critical lesson even when it succeeded', () => {
    const out = recallVorschau(LESSON_KEY, LESSON_JSON, 400).join('\n');
    expect(LESSON.outcome).toBe('success');
    expect(out).toContain('⚠️');
    expect(out).toContain('Ping-Scan');
  });

  it('stays bounded — a recall hit cannot flood the answer', () => {
    const riese = JSON.stringify({
      ...LESSON,
      what_worked: 'w'.repeat(9000),
      what_failed: 'f'.repeat(9000),
      commands: Array.from({ length: 40 }, (_, i) => `cmd-${i} ${'z'.repeat(400)}`),
    });
    expect(recallVorschau(LESSON_KEY, riese, 400).join('\n').length).toBeLessThan(900);
  });
});

describe('recallVorschau — everything that is not a lesson', () => {
  it('keeps a raw preview for context entries, trimmed with a visible marker', () => {
    const lang = 'kontext '.repeat(200);
    const out = recallVorschau('cachly:ctx:wip:foo.ts', lang, 120).join('\n');
    expect(out).toMatch(/…$/);
    expect(out.length).toBeLessThanOrEqual(122);
  });

  it('does not choke on a lesson key holding unparseable content', () => {
    const out = recallVorschau(LESSON_KEY, 'kein json, nur text', 200).join('\n');
    expect(out).toContain('kein json');
  });

  it('does not choke on an empty record', () => {
    expect(recallVorschau('cachly:ctx:leer', '', 200)).toEqual([]);
  });

  it('falls back to the raw preview when the JSON carries no lesson fields', () => {
    const out = recallVorschau(LESSON_KEY, JSON.stringify({ topic: 'x' }), 200).join('\n');
    expect(out).toContain('topic');
  });
});
