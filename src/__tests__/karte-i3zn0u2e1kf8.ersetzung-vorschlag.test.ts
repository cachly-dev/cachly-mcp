/**
 * Karte i3zn0u2e1kf8 — die Ersetzungs-Kante wird vorgeschlagen, nie gesetzt.
 *
 * Der Befund dahinter: 642 Lektionen im Live-Bestand, NULL mit
 * ersetzt_durch — das Feld wird beim echten Schreiben nie benutzt. Der
 * Vorschlag erinnert daran, mit Beleg; setzen muss der Schreiber.
 *
 * Die Heuristik ist absichtlich ENG (Signalwort + Nähe): lieber einen
 * echten Fall verpassen als Fehlvorschläge, die man sich abgewöhnt zu
 * lesen — die Gegenproben halten genau das fest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { schlageErsetzungVor, themenNaehe } from '../ersetzung-vorschlag.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('schlageErsetzungVor — die reine Heuristik', () => {
  const alt = [{ topic: 'deploy:cache-npm', what_worked: 'Der npm-Cache liegt an elf Stellen und wird von Hand geleert.' }];

  it('Signalwort + Themen-Naehe -> Vorschlag mit Beleg', () => {
    const v = schlageErsetzungVor(
      'deploy:cache-npm-zentral',
      'Der npm-Cache wird doch nicht von Hand geleert — stattdessen zentral per actions/cache.',
      alt,
    );
    expect(v).toContain('deploy:cache-npm');
    expect(v).toContain('ersetzt="deploy:cache-npm"');
    // Der Beleg steht drin — der Schreiber prueft die Heuristik, statt ihr
    // zu glauben.
    expect(v).toMatch(/doch nicht|stattdessen/);
  });

  it('GEGENPROBE: Naehe OHNE Signalwort -> kein Vorschlag', () => {
    const v = schlageErsetzungVor(
      'deploy:cache-npm-zentral',
      'Der npm-Cache wird zentral per actions/cache verwaltet.',
      alt,
    );
    expect(v).toBeNull();
  });

  it('GEGENPROBE: Signalwort OHNE Naehe -> kein Vorschlag', () => {
    const v = schlageErsetzungVor(
      'whisper:node4-adresse',
      'Die Adresse war doch nicht .4 — stattdessen ist node-4 der Peer .7.',
      alt,
    );
    expect(v).toBeNull();
  });

  it('das eigene Thema wird nie vorgeschlagen — das ist der normale Update-Pfad', () => {
    const v = schlageErsetzungVor(
      'deploy:cache-npm',
      'Doch nicht von Hand — stattdessen zentral.',
      [{ topic: 'deploy:cache-npm', what_worked: 'Von Hand leeren.' }],
    );
    expect(v).toBeNull();
  });

  it('themenNaehe misst geteilte Slug-Staemme', () => {
    expect(themenNaehe('deploy:cache-npm', 'deploy:cache-npm-zentral')).toBeGreaterThanOrEqual(0.5);
    expect(themenNaehe('deploy:cache-npm', 'whisper:node4')).toBe(0);
  });
});

describe('im Schreibpfad', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => { redis = new MockRedis(); });

  it('eine Gegenaussage zu einem bestehenden Thema bekommt den Vorschlag', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm', outcome: 'success',
      what_worked: 'Der plugh-Cache liegt an elf Stellen und wird von Hand geleert.',
    }, getConn, noopApiFetch);

    const out = String(await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm-zentral', outcome: 'success',
      what_worked: 'Der plugh-Cache wird doch nicht von Hand geleert — stattdessen zentral.',
    }, getConn, noopApiFetch));
    expect(out).toContain('Korrektur von');
    expect(out).toContain('ersetzt="deploy:cache-npm"');
  });

  it('GEGENPROBE: eine harmlose Lektion zu einem NEUEN Thema loest nichts aus', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm', outcome: 'success',
      what_worked: 'Der plugh-Cache liegt an elf Stellen.',
    }, getConn, noopApiFetch);

    const out = String(await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'monitoring:loki-rotation', outcome: 'success',
      what_worked: 'Das xyzzy-Log rotiert jetzt woechentlich per Timer.',
    }, getConn, noopApiFetch));
    expect(out).not.toContain('Korrektur von');
  });

  it('wer die Kante schon setzt, bekommt keinen Vorschlag obendrauf', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm', outcome: 'success',
      what_worked: 'Der plugh-Cache wird von Hand geleert.',
    }, getConn, noopApiFetch);

    const out = String(await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:cache-npm-zentral', outcome: 'success',
      what_worked: 'Der plugh-Cache wird doch nicht von Hand geleert — stattdessen zentral.',
      ersetzt: 'deploy:cache-npm',
    }, getConn, noopApiFetch));
    expect(out).not.toContain('Korrektur von');
    expect(out).toContain('verdraengt');
  });
});
