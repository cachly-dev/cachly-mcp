import { Redis } from 'ioredis';

// ── Layer 1: Causal Knowledge Graph (CKG) helpers ────────────────────────────
// Implements the CKG from the 10x Vision Document.
// Nodes: cachly:ckg:node:{id}  → { id, domain, type, count, ts }
// Edges: cachly:ckg:edge:{from}:{edgeType}:{to} → { from, to, edgeType, successes, trials, confidence, last_updated }

export type CKGEdge = {
  from: string; to: string; edgeType: string;
  successes: number; trials: number; confidence: number; last_updated: string;
};
export type CKGNode = { id: string; domain: string; type: string; count: number; ts: string };

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

export async function ckgUpdateEdge(redis: Redis, from: string, edgeType: string, to: string, success: boolean, partial = false): Promise<void> {
  const key = `cachly:ckg:edge:${from}:${edgeType}:${to}`;
  const raw = await redis.get(key);
  const edge: CKGEdge = raw ? JSON.parse(raw) : { from, to, edgeType, successes: 0, trials: 0, confidence: 0, last_updated: '' };
  edge.trials = (edge.trials || 0) + 1;
  if (success) edge.successes = (edge.successes || 0) + 1;
  else if (partial) edge.successes = (edge.successes || 0) + 0.5;
  // Beta distribution smoothed confidence: (successes+1) / (trials+2)
  edge.confidence = (edge.successes + 1) / (edge.trials + 2);
  edge.last_updated = new Date().toISOString();
  await redis.set(key, JSON.stringify(edge));
  // Index: set of edge keys per source node (for fast traversal)
  await redis.sadd(`cachly:ckg:idx:from:${from}`, key);
  await redis.sadd(`cachly:ckg:idx:to:${to}`, key);
}
