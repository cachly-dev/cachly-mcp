import type { Redis } from 'ioredis';
import { safeJsonParse } from '../utils.js';
import type { CKGEdge } from '../ckg.js';

// ── Brain Viz — 3D graph export ──────────────────────────────────────────────
// Exports the Causal Knowledge Graph (CKG) in a shape that a force-directed 3D
// frontend (react-force-graph-3d / three.js) can render directly, without any
// transform. This is the data layer behind cachly's "brain viz": the visual,
// explorable 3D rendering of everything the brain knows and how concepts,
// people, files and services causally relate.
//
// The frontend repo consumes this verbatim:
//   { schema, nodes: [{ id, name, type, group, val, ... }],
//     links: [{ source, target, type, value, trials }], meta }
//
// Node ids encode their kind by prefix: bare slug = concept, "person:…",
// "file:…", "service:…". Edges live at cachly:ckg:edge:{from}:{type}:{to}.

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const VIZ_TOOL_NAMES = new Set(['brain_graph']);

// Stable color groups so the 3D frontend can theme node kinds consistently.
const NODE_GROUP: Record<string, number> = {
  concept: 1, person: 2, file: 3, service: 4,
};

type StoredNode = {
  id: string; type?: string; domain?: string; count?: number;
  handle?: string; path?: string; name?: string;
};

type VizNode = {
  id: string;
  name: string;
  type: 'concept' | 'person' | 'file' | 'service';
  group: number;
  domain: string;
  /** Force-graph sphere size — scales with how often the node is referenced. */
  val: number;
  count: number;
};

type VizLink = {
  source: string;
  target: string;
  type: string;        // edgeType: fixes / causes / co-occurs / authored / collaborates …
  value: number;       // confidence 0..1 — drives link opacity/width in 3D
  trials: number;
};

function nodeKind(id: string): VizNode['type'] {
  if (id.startsWith('person:')) return 'person';
  if (id.startsWith('file:')) return 'file';
  if (id.startsWith('service:')) return 'service';
  return 'concept';
}

function nodeLabel(n: StoredNode, kind: VizNode['type']): string {
  if (kind === 'person') return n.handle ?? n.id.replace(/^person:/, '');
  if (kind === 'file') return (n.path ?? n.id.replace(/^file:/, '')).split('/').slice(-1)[0] ?? n.id;
  if (kind === 'service') return n.name ?? n.id.replace(/^service:/, '');
  return n.id;
}

async function scanAll(redis: Redis, match: string, limit: number): Promise<string[]> {
  const keys: string[] = [];
  const stream = redis.scanStream({ match, count: 200 });
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (batch: string[]) => {
      for (const k of batch) {
        if (keys.length < limit) keys.push(k);
      }
      if (keys.length >= limit) stream.destroy();
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });
  return keys;
}

export async function handleVizTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  _apiFetch: ApiFetch,
): Promise<string | null> {
  if (name !== 'brain_graph') return null;

  const {
    instance_id,
    max_nodes = 400,
    domain = '',
    min_confidence = 0,
    format = 'json',
  } = args as {
    instance_id: string;
    max_nodes?: number;
    domain?: string;
    min_confidence?: number;
    format?: 'json' | 'summary';
  };

  const redis = await getConnection(instance_id);
  const nodeCap = Math.max(1, Math.min(2000, Number(max_nodes) || 400));
  const minConf = Math.max(0, Math.min(1, Number(min_confidence) || 0));
  const domainFilter = String(domain || '').toLowerCase().trim();

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodeKeys = await scanAll(redis, 'cachly:ckg:node:*', nodeCap);
  const nodes: VizNode[] = [];
  const present = new Set<string>();
  for (const key of nodeKeys) {
    const raw = await redis.get(key);
    const stored = safeJsonParse<StoredNode | null>(raw, null);
    if (!stored || !stored.id) continue;
    const kind = nodeKind(stored.id);
    const ndomain = String(stored.domain ?? '').toLowerCase();
    if (domainFilter && !ndomain.includes(domainFilter) && !stored.id.toLowerCase().includes(domainFilter)) continue;
    const count = Number(stored.count ?? 1) || 1;
    nodes.push({
      id: stored.id,
      name: nodeLabel(stored, kind),
      type: kind,
      group: NODE_GROUP[kind] ?? 0,
      domain: stored.domain ?? '',
      val: Math.max(1, Math.round(Math.sqrt(count) * 3)),
      count,
    });
    present.add(stored.id);
  }

  // ── Edges ──────────────────────────────────────────────────────────────────
  // Edge keys: cachly:ckg:edge:{from}:{edgeType}:{to}. We read the stored CKGEdge
  // (not the key) so from/to/confidence come straight from the value — robust to
  // ids that themselves contain ':' (e.g. "docker:layer-cache").
  const edgeKeys = await scanAll(redis, 'cachly:ckg:edge:*', nodeCap * 8);
  const links: VizLink[] = [];
  let edgesSkippedConf = 0;
  let edgesSkippedDangling = 0;
  for (const key of edgeKeys) {
    const raw = await redis.get(key);
    const edge = safeJsonParse<CKGEdge | null>(raw, null);
    if (!edge || !edge.from || !edge.to) continue;
    if ((edge.confidence ?? 0) < minConf) { edgesSkippedConf++; continue; }
    // Drop dangling edges (endpoint filtered out) so the 3D graph stays consistent.
    if (!present.has(edge.from) || !present.has(edge.to)) { edgesSkippedDangling++; continue; }
    links.push({
      source: edge.from,
      target: edge.to,
      type: edge.edgeType ?? 'related',
      value: Number((edge.confidence ?? 0).toFixed(3)),
      trials: edge.trials ?? 0,
    });
  }

  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const graph = {
    schema: 'cachly.brain_graph/v1',
    nodes,
    links,
    meta: {
      instance_id,
      generated_at: new Date().toISOString(),
      node_count: nodes.length,
      link_count: links.length,
      node_types: byType,
      truncated: nodeKeys.length >= nodeCap,
      filters: { domain: domainFilter || null, min_confidence: minConf, max_nodes: nodeCap },
    },
  };

  if (format === 'summary') {
    const lines = [
      `## 🧠 Brain Graph — 3D Viz Export`,
      '',
      `**${nodes.length}** nodes · **${links.length}** links`,
      ...Object.entries(byType).map(([t, c]) => `  • ${t}: ${c}`),
      edgesSkippedConf ? `  • ${edgesSkippedConf} edges below confidence ${minConf}` : '',
      edgesSkippedDangling ? `  • ${edgesSkippedDangling} dangling edges dropped` : '',
      '',
      graph.meta.truncated ? `⚠️ Truncated at ${nodeCap} nodes — raise \`max_nodes\` for the full graph.` : '',
      '',
      `Call \`brain_graph(instance_id="${instance_id}", format="json")\` for the full payload the 3D frontend renders.`,
    ].filter(Boolean);
    return lines.join('\n');
  }

  // Default: emit the renderable payload in a fenced block so the frontend /
  // API can lift it verbatim into react-force-graph-3d.
  return [
    `🧠 **Brain Graph** — ${nodes.length} nodes, ${links.length} links (schema \`cachly.brain_graph/v1\`)`,
    '',
    '```json',
    JSON.stringify(graph, null, 2),
    '```',
  ].join('\n');
}
