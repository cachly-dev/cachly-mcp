/**
 * Role model tests — team_assign_role · team_whoami · team_roster
 * and the integration with team_confirm (role-aware review level).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  hasPermission, roleToReviewLevel, getRole,
  ROLE_BADGE, ROLES_KEY,
  getScopes, lessonVisibleToScope,
  type TeamRole,
} from '../handlers/team.js';
import { handleTeamTool } from '../handlers/team.js';

// ── Minimal Redis mock (hash, sadd, scard, expire) ───────────────────────────
class MockRedis {
  private store = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();
  private lists = new Map<string, string[]>();

  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string) { this.store.set(k, v); return 'OK'; }
  async hset(k: string, f: string, v: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    this.hashes.get(k)!.set(f, v); return 1;
  }
  async hget(k: string, f: string) { return this.hashes.get(k)?.get(f) ?? null; }
  async hgetall(k: string): Promise<Record<string, string>> {
    const h = this.hashes.get(k);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }
  async expire(_k: string, _s: number) { return 1; }
  async rpush(k: string, ...vals: string[]) {
    if (!this.lists.has(k)) this.lists.set(k, []);
    this.lists.get(k)!.push(...vals);
    return this.lists.get(k)!.length;
  }
  async ltrim(_k: string, _s: number, _e: number) { return 'OK'; }
  async sadd(k: string, ...members: string[]) {
    if (!this.sets.has(k)) this.sets.set(k, new Set());
    const s = this.sets.get(k)!;
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    return added;
  }
  async scard(k: string) { return this.sets.get(k)?.size ?? 0; }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])]; }
  async sismember(k: string, m: string) { return this.sets.get(k)?.has(m) ? 1 : 0; }
  async srem(k: string, m: string) { const s = this.sets.get(k); if (s?.has(m)) { s.delete(m); return 1; } return 0; }
  scanStream() {
    const e = { handlers: {} as Record<string, ((...a: unknown[]) => void)> };
    setTimeout(() => { e.handlers['data']?.([]); e.handlers['end']?.(); }, 0);
    return { on: (ev: string, fn: (...a: unknown[]) => void) => { e.handlers[ev] = fn; return { on: () => {} }; } };
  }
}

const noopApiFetch = async <T>(_p: string): Promise<T> => ({ data: [] } as unknown as T);
const iid = 'test-instance';

// ── Pure unit tests ───────────────────────────────────────────────────────────
describe('hasPermission', () => {
  it('returns false for null role', () => {
    expect(hasPermission(null, 'viewer')).toBe(false);
  });
  it('admin passes every required level', () => {
    for (const r of ['admin', 'reviewer', 'contributor', 'viewer'] as TeamRole[]) {
      expect(hasPermission('admin', r)).toBe(true);
    }
  });
  it('viewer only passes viewer', () => {
    expect(hasPermission('viewer', 'viewer')).toBe(true);
    expect(hasPermission('viewer', 'contributor')).toBe(false);
    expect(hasPermission('viewer', 'reviewer')).toBe(false);
    expect(hasPermission('viewer', 'admin')).toBe(false);
  });
  it('reviewer passes reviewer and below, not admin', () => {
    expect(hasPermission('reviewer', 'reviewer')).toBe(true);
    expect(hasPermission('reviewer', 'contributor')).toBe(true);
    expect(hasPermission('reviewer', 'admin')).toBe(false);
  });
});

describe('roleToReviewLevel', () => {
  it('admin and reviewer → senior', () => {
    expect(roleToReviewLevel('admin')).toBe('senior');
    expect(roleToReviewLevel('reviewer')).toBe('senior');
  });
  it('contributor and viewer → peer', () => {
    expect(roleToReviewLevel('contributor')).toBe('peer');
    expect(roleToReviewLevel('viewer')).toBe('peer');
  });
  it('null → peer', () => {
    expect(roleToReviewLevel(null)).toBe('peer');
  });
});

describe('ROLE_BADGE', () => {
  it('has a badge for each role', () => {
    for (const r of ['admin', 'reviewer', 'contributor', 'viewer'] as TeamRole[]) {
      expect(ROLE_BADGE[r]).toBeTruthy();
    }
  });
});

describe('getRole', () => {
  it('returns null when no role is assigned', async () => {
    const redis = new MockRedis() as unknown as Redis;
    expect(await getRole(redis, iid, 'alice')).toBeNull();
  });

  it('reads back a stored role (case-insensitive handle)', async () => {
    const redis = new MockRedis() as unknown as Redis;
    await (redis as unknown as MockRedis).hset(ROLES_KEY(iid), 'alice', 'reviewer');
    expect(await getRole(redis, iid, 'alice')).toBe('reviewer');
    expect(await getRole(redis, iid, 'Alice')).toBe('reviewer'); // lower-cased by getRole
  });
});

// ── Integration tests (via handleTeamTool) ───────────────────────────────────
describe('team_assign_role', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('bootstraps the first admin without requiring assigned_by', async () => {
    const out = await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'alice', role: 'admin' }, getConn, noopApiFetch);
    expect(out).toContain('Role assigned');
    expect(out).toContain('alice');
    expect(out).toContain('admin');
    expect(out).toContain('First admin bootstrapped');
  });

  it('assigns contributor without admin check when bootstrapping', async () => {
    const out = await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'bob', role: 'contributor' }, getConn, noopApiFetch);
    expect(out).toContain('Role assigned');
  });

  it('rejects assignment after bootstrap if assigned_by has no admin role', async () => {
    // Bootstrap alice as admin
    await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'alice', role: 'admin' }, getConn, noopApiFetch);
    // Bob (contributor) tries to promote carol
    await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'bob', role: 'contributor' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'carol', role: 'reviewer', assigned_by: 'bob' }, getConn, noopApiFetch);
    expect(out).toContain('Permission denied');
  });

  it('allows an admin to assign roles after bootstrap', async () => {
    await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'alice', role: 'admin' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'bob', role: 'reviewer', assigned_by: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('Role assigned');
    expect(out).toContain('bob');
    expect(out).toContain('reviewer');
  });

  it('rejects unknown role values', async () => {
    const out = await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'alice', role: 'superuser' as TeamRole }, getConn, noopApiFetch);
    expect(out).toContain('Unknown role');
  });
});

describe('team_whoami', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('reports no role when none assigned', async () => {
    const out = await handleTeamTool('team_whoami',
      { instance_id: iid, handle: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('no assigned role');
  });

  it('shows role and capabilities when role is set', async () => {
    await handleTeamTool('team_assign_role',
      { instance_id: iid, handle: 'alice', role: 'reviewer' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_whoami',
      { instance_id: iid, handle: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('reviewer');
    expect(out).toContain('senior-review');
  });
});

describe('team_roster', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('shows empty state when no roles assigned', async () => {
    const out = await handleTeamTool('team_roster',
      { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('No roles assigned');
  });

  it('lists all members with roles sorted by rank', async () => {
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'carol', role: 'reviewer' }, getConn, noopApiFetch);
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'alice', role: 'admin', assigned_by: 'carol' }, getConn, noopApiFetch);
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'bob', role: 'contributor', assigned_by: 'alice' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_roster', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('alice');
    expect(out).toContain('bob');
    expect(out).toContain('carol');
    // Admin should appear before contributor in the table
    const adminIdx = out.indexOf('admin');
    const contribIdx = out.indexOf('contributor');
    expect(adminIdx).toBeLessThan(contribIdx);
  });
});

describe('team_confirm role-aware review level', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  const storeLesson = async () => handleTeamTool('team_learn',
    { instance_id: iid, topic: 'fix:auth', what_worked: 'rotate key', outcome: 'success', author: 'system' },
    getConn, noopApiFetch);

  it('grants senior review level to a reviewer-role user without explicit level param', async () => {
    await storeLesson();
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'alice', role: 'reviewer' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_confirm',
      { instance_id: iid, topic: 'fix:auth', reviewer: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('🛡️ senior-reviewed');
  });

  it('grants only peer review to a contributor', async () => {
    await storeLesson();
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'bob', role: 'contributor' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_confirm',
      { instance_id: iid, topic: 'fix:auth', reviewer: 'bob' }, getConn, noopApiFetch);
    expect(out).toContain('✔️ peer-reviewed');
  });

  it('cannot self-promote to senior without the role (explicit level=senior on a contributor)', async () => {
    await storeLesson();
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'eve', role: 'contributor' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_confirm',
      { instance_id: iid, topic: 'fix:auth', reviewer: 'eve', level: 'senior' }, getConn, noopApiFetch);
    expect(out).toContain('✔️ peer-reviewed');
    expect(out).not.toContain('🛡️ senior-reviewed');
  });

  it('shows the role badge in the confirmation message', async () => {
    await storeLesson();
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'alice', role: 'reviewer' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_confirm',
      { instance_id: iid, topic: 'fix:auth', reviewer: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('reviewer');
    expect(out).toContain(ROLE_BADGE['reviewer']);
  });
});

// ── Team-level visibility scopes (groups) ─────────────────────────────────────
describe('lessonVisibleToScope', () => {
  it('team-wide lessons (no group) are always visible', () => {
    expect(lessonVisibleToScope(undefined, new Set(), false)).toBe(true);
    expect(lessonVisibleToScope('', new Set(), false)).toBe(true);
    expect(lessonVisibleToScope(null, new Set(), false)).toBe(true);
  });
  it('group-scoped lessons require membership', () => {
    expect(lessonVisibleToScope('security', new Set(['security']), false)).toBe(true);
    expect(lessonVisibleToScope('security', new Set(['backend']), false)).toBe(false);
    expect(lessonVisibleToScope('security', new Set(), false)).toBe(false);
  });
  it('admins see every group', () => {
    expect(lessonVisibleToScope('security', new Set(), true)).toBe(true);
  });
  it('is case-insensitive on the group name', () => {
    expect(lessonVisibleToScope('Security', new Set(['security']), false)).toBe(true);
  });
});

describe('getScopes', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  it('returns empty set for a person in no groups', async () => {
    const s = await getScopes(redis as unknown as Redis, iid, 'nobody');
    expect(s.size).toBe(0);
  });

  it('returns the groups a member belongs to', async () => {
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'alice', group: 'backend' }, getConn, noopApiFetch);
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'alice', group: 'security' }, getConn, noopApiFetch);
    const s = await getScopes(redis as unknown as Redis, iid, 'alice');
    expect(s.has('backend')).toBe(true);
    expect(s.has('security')).toBe(true);
    expect(s.size).toBe(2);
  });
});

describe('team_grant_scope', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  it('adds a member to a group (bootstrap, no admin yet)', async () => {
    const out = await handleTeamTool('team_grant_scope',
      { instance_id: iid, handle: 'alice', group: 'backend' }, getConn, noopApiFetch);
    expect(out).toContain('Scope granted');
    expect(out).toContain('backend');
  });

  it('blocks non-admins from managing scopes after bootstrap', async () => {
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'admin1', role: 'admin' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_grant_scope',
      { instance_id: iid, handle: 'bob', group: 'backend', assigned_by: 'bob' }, getConn, noopApiFetch);
    expect(out).toContain('Permission denied');
  });

  it('lets an admin grant scopes after bootstrap', async () => {
    await handleTeamTool('team_assign_role', { instance_id: iid, handle: 'admin1', role: 'admin' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_grant_scope',
      { instance_id: iid, handle: 'bob', group: 'backend', assigned_by: 'admin1' }, getConn, noopApiFetch);
    expect(out).toContain('Scope granted');
  });

  it('removes a member with action=remove', async () => {
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'alice', group: 'backend' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_grant_scope',
      { instance_id: iid, handle: 'alice', group: 'backend', action: 'remove' }, getConn, noopApiFetch);
    expect(out).toContain('removed');
    const s = await getScopes(redis as unknown as Redis, iid, 'alice');
    expect(s.has('backend')).toBe(false);
  });
});

describe('team_scopes', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  it('reports empty state when no groups defined', async () => {
    const out = await handleTeamTool('team_scopes', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('No groups defined');
  });

  it('lists all groups and members', async () => {
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'alice', group: 'backend' }, getConn, noopApiFetch);
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'bob', group: 'backend' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_scopes', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('backend');
    expect(out).toContain('alice');
    expect(out).toContain('bob');
  });

  it('shows a single person\'s scopes when handle is passed', async () => {
    await handleTeamTool('team_grant_scope', { instance_id: iid, handle: 'alice', group: 'security' }, getConn, noopApiFetch);
    const out = await handleTeamTool('team_scopes', { instance_id: iid, handle: 'alice' }, getConn, noopApiFetch);
    expect(out).toContain('security');
    const out2 = await handleTeamTool('team_scopes', { instance_id: iid, handle: 'nobody' }, getConn, noopApiFetch);
    expect(out2).toContain('no groups');
  });
});
