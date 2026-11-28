/**
 * Attrappen fuer die Stufe-2-Proben (PR 2): ein Speicher, der sich wie der
 * Benutzer eines Mitglieds mit dem ACL-Muster verhaelt, und eine API, die
 * /role, /learn, /lessons/confirm und /lessons/recalled beantwortet.
 *
 * Der Speicher schreibt jedes Schreiben mit (Befehl, Schluessel). Ist er ein
 * Mitglied, wirft er bei jedem Schluessel, den das Muster sperrt, wie Valkey:
 * eine abgelehnte Zusage mit "NOPERM ..." (schluessel-klassen.ts,
 * mitgliedDarfSchreiben, wortgleich mit acl.go).
 */

import { mitgliedDarfSchreiben } from '../../schluessel-klassen.js';

/** Schreibbefehle und welche Argumente Schluessel sind. */
const ERSTER = (a: unknown[]) => [String(a[0])];
const ALLE = (a: unknown[]) => a.filter((x) => typeof x === 'string').map(String);
const PAARE = (a: unknown[]) => a.filter((_, i) => i % 2 === 0).map(String);
const ZWEI = (a: unknown[]) => [String(a[0]), String(a[1])];

export const SCHREIBBEFEHLE: Readonly<Record<string, (a: unknown[]) => string[]>> = {
  set: ERSTER, setex: ERSTER, psetex: ERSTER, setnx: ERSTER, getset: ERSTER, getdel: ERSTER, append: ERSTER,
  incr: ERSTER, incrby: ERSTER, incrbyfloat: ERSTER, decr: ERSTER, decrby: ERSTER,
  expire: ERSTER, pexpire: ERSTER, expireat: ERSTER, persist: ERSTER,
  del: ALLE, unlink: ALLE,
  mset: PAARE, msetnx: PAARE,
  hset: ERSTER, hmset: ERSTER, hsetnx: ERSTER, hdel: ERSTER, hincrby: ERSTER, hincrbyfloat: ERSTER,
  lpush: ERSTER, rpush: ERSTER, lpushx: ERSTER, rpushx: ERSTER, lpop: ERSTER, rpop: ERSTER,
  lset: ERSTER, ltrim: ERSTER, lrem: ERSTER, linsert: ERSTER,
  sadd: ERSTER, srem: ERSTER, spop: ERSTER, smove: ZWEI,
  zadd: ERSTER, zrem: ERSTER, zincrby: ERSTER, zremrangebyscore: ERSTER, zremrangebyrank: ERSTER, zpopmin: ERSTER, zpopmax: ERSTER,
  xadd: ERSTER, xtrim: ERSTER, xdel: ERSTER,
  rename: ZWEI, renamenx: ZWEI, copy: ZWEI,
  pfadd: ERSTER, setbit: ERSTER, setrange: ERSTER,
};

export interface Schreiben { befehl: string; schluessel: string }

export interface Protokoll {
  /** Jedes Schreiben, das ankam (auch abgewiesene). */
  schreiben: Schreiben[];
  /** Was das Muster abgewiesen hat. */
  abgewiesen: Schreiben[];
}

function noperm(befehl: string, schluessel: string): Error {
  const e = new Error(`NOPERM User m-0123456789abcdef has no permissions to access the '${schluessel}' key`);
  (e as Error & { command?: unknown }).command = { name: befehl };
  return e;
}

/**
 * Legt die Attrappe um einen Speicher (z. B. MockRedis). `mitglied: true`
 * verhaelt sich wie der eingeschraenkte Benutzer; `mitglied: false` schreibt
 * nur mit. `unbekannt: 'null'` laesst fehlende Befehle still null liefern
 * (fuer den Durchlauf aller Werkzeuge), sonst wie die Attrappe selbst.
 */
export function aclAttrappe<T extends object>(
  basis: T,
  opt: { mitglied: boolean; unbekannt?: 'null' | 'fehler'; konto?: string },
): { redis: T; protokoll: Protokoll } {
  const protokoll: Protokoll = { schreiben: [], abgewiesen: [] };
  const pruefe = (befehl: string, args: unknown[]): Error | null => {
    const keys = SCHREIBBEFEHLE[befehl]?.(args) ?? [];
    let fehler: Error | null = null;
    for (const k of keys) {
      protokoll.schreiben.push({ befehl, schluessel: k });
      if (opt.mitglied && !(opt.konto && k.startsWith(opt.konto)) && !mitgliedDarfSchreiben(k)) {
        protokoll.abgewiesen.push({ befehl, schluessel: k });
        fehler ??= noperm(befehl, k);
      }
    }
    return fehler;
  };
  const buendel = (roh: Record<string, unknown>) => {
    const abgelehnt = new Map<number, Error>();
    let i = 0;
    const p: Record<string, unknown> = new Proxy(roh, {
      get(z, name) {
        const w = Reflect.get(z, name, z);
        if (name === 'exec' && typeof w === 'function') {
          return async () => {
            const erg = (await (w as () => Promise<unknown[]>).apply(z, [])) ?? [];
            return (erg as unknown[]).map((e, j) => (abgelehnt.has(j) ? [abgelehnt.get(j), null] : e));
          };
        }
        if (typeof name === 'string' && typeof w === 'function') {
          return (...a: unknown[]) => {
            const f = SCHREIBBEFEHLE[name] ? pruefe(name, a) : null;
            if (f) abgelehnt.set(i, f);
            i++;
            (w as (...x: unknown[]) => unknown).apply(z, a);
            return p;
          };
        }
        return w;
      },
    });
    return p;
  };
  const redis = new Proxy(basis, {
    get(z, name) {
      const w = Reflect.get(z, name, z);
      if (typeof name !== 'string') return w;
      if (name === 'pipeline' && typeof w === 'function') {
        return () => buendel((w as () => Record<string, unknown>).apply(z, []));
      }
      if (typeof w !== 'function') {
        if (w === undefined && opt.unbekannt === 'null' && name !== 'then' && !name.startsWith('_')) {
          return async (...a: unknown[]) => {
            if (SCHREIBBEFEHLE[name]) { const f = pruefe(name, a); if (f) throw f; }
            return null;
          };
        }
        return w;
      }
      if (!SCHREIBBEFEHLE[name]) return (...a: unknown[]) => (w as (...x: unknown[]) => unknown).apply(z, a);
      return (...a: unknown[]) => {
        const f = pruefe(name, a);
        if (f) return Promise.reject(f);
        return (w as (...x: unknown[]) => unknown).apply(z, a);
      };
    },
  });
  return { redis, protokoll };
}

// ── Die API ─────────────────────────────────────────────────────────────────

export interface ApiAufruf { methode: string; pfad: string; koerper?: unknown }

export interface ApiAttrappe {
  api: <T>(pfad: string, optionen?: RequestInit) => Promise<T>;
  aufrufe: ApiAufruf[];
  /** Antwort von GET /role; null = 404 (alte API). */
  rolle: Record<string, unknown> | null;
  /** Wirft POST /learn mit 403 role_<rolle>? */
  lernenVerboten?: string;
  /** POST /learn antwortet mit proposed:true. */
  vorschlag?: boolean;
}

export function apiFehlerMit(status: number, koerper: Record<string, unknown> = {}): Error {
  const e = new Error(`cachly API error ${status}: ${String(koerper.error ?? 'fehler')}`);
  Object.assign(e, { apiStatus: status, ...(koerper.code ? { apiCode: koerper.code } : {}), ...(koerper.role ? { apiRole: koerper.role } : {}), ...(koerper.reason ? { apiReason: koerper.reason } : {}) });
  return e;
}

/** Eine Rollen-Antwort wie GET /instances/:id/role. */
export function rollenAntwort(role: string, source = role === 'admin' ? 'owner' : 'default'): Record<string, unknown> {
  const kann = {
    admin: { learn: true, confirm: true, withdraw: true, manage: true },
    reviewer: { learn: true, confirm: true, withdraw: true, manage: false },
    contributor: { learn: true, confirm: false, withdraw: false, manage: false },
    viewer: { learn: false, confirm: false, withdraw: false, manage: false },
  }[role] ?? {};
  return { role, source, can: kann, review_mode: false, protection: 'on', knowledge: { brain: 0, org: 0 }, min_mcp: '0.10.281' };
}

export function apiAttrappe(start: Partial<Omit<ApiAttrappe, 'api' | 'aufrufe'>> = {}): ApiAttrappe {
  const a: ApiAttrappe = {
    aufrufe: [],
    rolle: start.rolle === undefined ? rollenAntwort('contributor') : start.rolle,
    lernenVerboten: start.lernenVerboten,
    vorschlag: start.vorschlag,
    api: async <T>(pfad: string, optionen?: RequestInit): Promise<T> => {
      const methode = (optionen?.method ?? 'GET').toUpperCase();
      const koerper = typeof optionen?.body === 'string' ? JSON.parse(optionen.body) : undefined;
      a.aufrufe.push({ methode, pfad, ...(koerper !== undefined ? { koerper } : {}) });
      if (methode === 'GET' && /\/role$/.test(pfad)) {
        if (!a.rolle) throw apiFehlerMit(404, { error: 'not found' });
        return a.rolle as T;
      }
      if (methode === 'POST' && /\/learn$/.test(pfad)) {
        if (a.lernenVerboten) {
          throw apiFehlerMit(403, { error: `your role in this brain (${a.lernenVerboten}) does not allow this`, code: `role_${a.lernenVerboten}`, role: a.lernenVerboten });
        }
        const k = koerper as { topic?: string };
        return { ok: true, topic: k?.topic, ...(a.vorschlag ? { proposed: true } : {}) } as T;
      }
      if (methode === 'POST' && /\/lessons\/confirm$/.test(pfad)) {
        const r = String((a.rolle as { role?: string } | null)?.role ?? '');
        if (r !== 'admin' && r !== 'reviewer') throw apiFehlerMit(403, { error: 'no', code: `role_${r}`, role: r });
        const k = koerper as { topic?: string };
        return { topic: k?.topic, review_level: 'senior', endorsements: 1, reviewed_by: 'Konto Bob' } as T;
      }
      if (methode === 'POST' && /\/lessons\/recalled$/.test(pfad)) {
        return { updated: (koerper as { topics?: unknown[] })?.topics?.length ?? 0 } as T;
      }
      if (methode === 'GET' && /^\/api\/v1\/instances\/[^/]+$/.test(pfad)) {
        return { id: pfad.split('/').pop(), name: 'Probe-Brain', status: 'running', tier: 'free', host: '127.0.0.1', port: 9 } as T;
      }
      if (methode === 'GET' && /\/members$/.test(pfad)) {
        return { members: [{ display_name: 'Anna', role: 'admin', source: 'owner' }, { display_name: 'Bob', role: 'contributor', source: 'default' }], count: 2 } as T;
      }
      return null as T;
    },
  };
  return a;
}

export function aufrufeNach(a: ApiAttrappe, methode: string, ende: RegExp): ApiAufruf[] {
  return a.aufrufe.filter((x) => x.methode === methode && ende.test(x.pfad));
}
