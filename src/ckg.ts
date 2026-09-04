import { Redis } from 'ioredis';

// ── Layer 1: Causal Knowledge Graph (CKG) helpers ────────────────────────────
// Nodes: cachly:ckg:node:{id}  → CKGNode | PersonNode | FileNode
// Edges: cachly:ckg:edge:{from}:{edgeType}:{to} → CKGEdge

export type CKGEdge = {
  from: string; to: string; edgeType: string;
  successes: number; trials: number; confidence: number; last_updated: string;
};

export type CKGNode = { id: string; domain: string; type: string; count: number; ts: string };

// Phase 3A: People nodes — auto-built from learn_from_attempts(author=...)
export type PersonNode = {
  id: string;          // "person:{slug}"
  handle: string;      // original author string as provided
  domain: string;      // first/primary problem domain seen
  type: 'person';
  count: number;       // number of lessons authored
  last_active: string; // ISO timestamp of most recent contribution
};

// Phase 3A: File nodes — auto-built from learn_from_attempts(file_paths=[...])
export type FileNode = {
  id: string;    // "file:{slug}"
  path: string;  // original file path
  domain: string;
  type: 'file';
  count: number; // number of times referenced in lessons
  ts: string;
};

// Phase 3: Service/System nodes — the deployable units a team operates
// (e.g. "cachly-web", "prometheus", "auth-service"). Auto-built from
// learn_from_attempts(service=...). Lets the brain answer "who owns X, and what
// has gone wrong with X before?" — the bridge from a lesson to a running system.
export type ServiceNode = {
  id: string;            // "service:{slug}"
  name: string;          // original service name as provided
  kind: 'service' | 'system'; // 'system' for infra (prometheus, k8s), 'service' for app units
  domain: string;        // primary problem domain seen
  type: 'service';
  count: number;         // number of lessons referencing this service
  last_active: string;   // ISO timestamp of most recent contribution
};

const STOPWORDS_CKG = new Set(['that','this','with','from','when','then','also','have','been','will','were','they','them','than','more','some','into','over','only','just','where','while','which','there','their','would','could','should','after','before','about']);

export function ckgSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\-:]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/** Extract 1-3 significant keywords from free text for a problem concept */
export function extractProblemConcept(text: string): string | null {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS_CKG.has(w))
    .slice(0, 5);
  if (words.length === 0) return null;
  return words.slice(0, 2).join('-');
}

export async function ckgUpsertNode(redis: Redis, id: string, domain: string, type: string): Promise<void> {
  const key = `cachly:ckg:node:${id}`;
  const raw = await redis.get(key);
  const node: CKGNode = raw ? JSON.parse(raw) : { id, domain, type, count: 0, ts: new Date().toISOString() };
  node.count = (node.count || 0) + 1;
  node.ts = new Date().toISOString();
  await redis.set(key, JSON.stringify(node));
}

/** Upsert a Person node; returns the node id ("person:{slug}"). */
export async function ckgUpsertPersonNode(redis: Redis, handle: string, domain: string): Promise<string> {
  const id = `person:${ckgSlug(handle)}`;
  const key = `cachly:ckg:node:${id}`;
  const raw = await redis.get(key);
  const node: PersonNode = raw
    ? JSON.parse(raw)
    : { id, handle, domain, type: 'person', count: 0, last_active: new Date().toISOString() };
  node.count = (node.count || 0) + 1;
  node.last_active = new Date().toISOString();
  if (!node.domain) node.domain = domain;
  await redis.set(key, JSON.stringify(node));
  return id;
}

/** Upsert a File node; returns the node id ("file:{slug}"). */
export async function ckgUpsertFileNode(redis: Redis, filePath: string): Promise<string> {
  const dir = filePath.split('/')[0] ?? 'root';
  const id = `file:${ckgSlug(filePath)}`;
  const key = `cachly:ckg:node:${id}`;
  const raw = await redis.get(key);
  const node: FileNode = raw
    ? JSON.parse(raw)
    : { id, path: filePath, domain: dir, type: 'file', count: 0, ts: new Date().toISOString() };
  node.count = (node.count || 0) + 1;
  node.ts = new Date().toISOString();
  await redis.set(key, JSON.stringify(node));
  return id;
}

/** Upsert a Service/System node; returns the node id ("service:{slug}"). */
export async function ckgUpsertServiceNode(redis: Redis, name: string, domain: string, kind: 'service' | 'system' = 'service'): Promise<string> {
  const id = `service:${ckgSlug(name)}`;
  const key = `cachly:ckg:node:${id}`;
  const raw = await redis.get(key);
  const node: ServiceNode = raw
    ? JSON.parse(raw)
    : { id, name, kind, domain, type: 'service', count: 0, last_active: new Date().toISOString() };
  node.count = (node.count || 0) + 1;
  node.last_active = new Date().toISOString();
  if (!node.domain) node.domain = domain;
  // A node may start life as a 'service' and later be classified as 'system' (or vice
  // versa) by an explicit caller — honour the latest non-default classification.
  if (kind === 'system') node.kind = 'system';
  await redis.set(key, JSON.stringify(node));
  return id;
}

/**
 * Die EINE Fortschreibungs-Rechnung fuer eine Kante — vom Einzelweg und vom
 * Buendelweg geteilt. Zwei Rechnungen waeren zwei Wahrheiten (die
 * Fehlerklasse, die uns am haeufigsten trifft).
 */
export function schreibeKanteFort(raw: string | null, from: string, edgeType: string, to: string, success: boolean, partial = false): CKGEdge {
  const edge: CKGEdge = raw ? JSON.parse(raw) : { from, to, edgeType, successes: 0, trials: 0, confidence: 0, last_updated: '' };
  edge.trials = (edge.trials || 0) + 1;
  if (success) edge.successes = (edge.successes || 0) + 1;
  else if (partial) edge.successes = (edge.successes || 0) + 0.5;
  // Beta distribution smoothed confidence: (successes+1) / (trials+2)
  edge.confidence = (edge.successes + 1) / (edge.trials + 2);
  edge.last_updated = new Date().toISOString();
  return edge;
}

export async function ckgUpdateEdge(redis: Redis, from: string, edgeType: string, to: string, success: boolean, partial = false): Promise<void> {
  const key = `cachly:ckg:edge:${from}:${edgeType}:${to}`;
  const raw = await redis.get(key);
  const edge = schreibeKanteFort(raw, from, edgeType, to, success, partial);
  await redis.set(key, JSON.stringify(edge));
  // Index: set of edge keys per source node (for fast traversal)
  await redis.sadd(`cachly:ckg:idx:from:${from}`, key);
  await redis.sadd(`cachly:ckg:idx:to:${to}`, key);
}

export interface KantenAenderung { from: string; edgeType: string; to: string; success: boolean; partial?: boolean }

/**
 * Viele Kanten, VIER Netz-Runden statt vier je Kante (Karte 3u4skv7w35kq).
 *
 * Der Einzelweg macht je Kante get+set+sadd+sadd — ueber einen Cloud-Redis
 * sind das vier Round-Trips mal N. ckgRecordCollaboration erreichte damit
 * bis zu ~200 Runden je Datei (25 Co-Toucher, symmetrische Kanten). Hier:
 * EIN mget, Fortschreibung im Speicher (Duplikate im Buendel werden
 * SEQUENZIELL fortgeschrieben, kein verlorenes Update), EIN pipeline-exec
 * fuer alle set/sadd.
 *
 * Faellt auf den Einzelweg zurueck, wenn die Verbindung kein pipeline kann
 * (aeltere Mocks) — Verhalten vor Geschwindigkeit.
 */
export async function ckgUpdateEdgesGebuendelt(redis: Redis, aenderungen: readonly KantenAenderung[]): Promise<void> {
  if (aenderungen.length === 0) return;
  // Nicht nur OB es eine pipeline gibt, sondern ob sie set/sadd KANN —
  // aeltere Test-Mocks haben eine Nur-get-Pipeline (Beleg: brain-flow).
  const roheVerbindung = redis as unknown as { pipeline?: () => Record<string, unknown>; mget?: unknown };
  const probe = typeof roheVerbindung.pipeline === 'function' ? roheVerbindung.pipeline() : null;
  const kannBuendeln = probe !== null
    && typeof probe.set === 'function'
    && typeof probe.sadd === 'function'
    && typeof roheVerbindung.mget === 'function';
  if (!kannBuendeln) {
    for (const a of aenderungen) await ckgUpdateEdge(redis, a.from, a.edgeType, a.to, a.success, a.partial ?? false);
    return;
  }
  const schluesselFuer = (a: KantenAenderung) => `cachly:ckg:edge:${a.from}:${a.edgeType}:${a.to}`;
  const einmalige = [...new Set(aenderungen.map(schluesselFuer))];
  const rohe = await redis.mget(...einmalige);
  const stand = new Map<string, string | null>(einmalige.map((k, i) => [k, rohe[i] ?? null]));
  for (const a of aenderungen) {
    const k = schluesselFuer(a);
    const edge = schreibeKanteFort(stand.get(k) ?? null, a.from, a.edgeType, a.to, a.success, a.partial ?? false);
    stand.set(k, JSON.stringify(edge));
  }
  const p = probe as unknown as { set: (k: string, v: string) => unknown; sadd: (k: string, m: string) => unknown; exec: () => Promise<unknown> };
  for (const a of aenderungen) {
    const k = schluesselFuer(a);
    p.set(k, stand.get(k) as string);
    p.sadd(`cachly:ckg:idx:from:${a.from}`, k);
    p.sadd(`cachly:ckg:idx:to:${a.to}`, k);
  }
  await p.exec();
}

/**
 * Phase 3: Collaboration graph. When `personId` touches `fileId`, record a
 * bidirectional `collaborates` edge to every *other* person who has touched the
 * same file. Builds the person↔person graph organically — "who works with whom".
 * Bounded: only the first MAX_CO_TOUCHERS prior touchers are linked, so a hot file
 * touched by hundreds of people can't blow up the write path.
 */
const MAX_CO_TOUCHERS = 25;
export async function ckgRecordCollaboration(redis: Redis, fileId: string, personId: string): Promise<void> {
  const touchersKey = `cachly:ckg:file:touchers:${fileId}`;
  const priorTouchers = await redis.smembers(touchersKey);
  const aenderungen: KantenAenderung[] = [];
  for (const other of priorTouchers.slice(0, MAX_CO_TOUCHERS)) {
    if (other === personId) continue;
    // Symmetric edges so traversal works from either node.
    aenderungen.push({ from: personId, edgeType: 'collaborates', to: other, success: true });
    aenderungen.push({ from: other, edgeType: 'collaborates', to: personId, success: true });
  }
  await ckgUpdateEdgesGebuendelt(redis, aenderungen);
  await redis.sadd(touchersKey, personId);
}
