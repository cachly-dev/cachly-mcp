#!/usr/bin/env node
/**
 * Baut die Datengrundlage fuer die Doku-Startseite (web/app/docs).
 *
 * WARUM ES DAS GIBT: Die 122 Werkzeuge tragen in tools.ts Ueberschriften, die
 * aus der Entwicklungsgeschichte stammen — "v4 Move 1", "Layer 6: FedBrain",
 * "Phase 3". Fuer uns sagen die etwas, fuer einen Besucher nichts. brain_doctor
 * steht unter "Roadmap", die team_*-Werkzeuge stehen unter "AI Brain — Extended
 * features". Wer die Doku aufschlaegt, findet darin keine Ordnung, weil keine
 * drin ist.
 *
 * Diese Datei liefert die zweite Sicht: dieselben Werkzeuge, sortiert nach dem,
 * was jemand vorhat. Namen, Beschreibungen und Pflichtfelder kommen aus
 * tools.ts — sie werden hier NICHT abgeschrieben. Von Hand gepflegt ist allein
 * die Zuordnung Werkzeug → Bereich, und die ist in beide Richtungen bewacht:
 * ein neues Werkzeug ohne Bereich laesst den Lauf scheitern, ein Bereich mit
 * einem Werkzeug, das es nicht mehr gibt, ebenso. Ein Werkzeug kann also nicht
 * still aus der Doku verschwinden.
 *
 * CLI:  node scripts/docs-atlas.mjs write|check|summary
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadToolCatalog } from './tool-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const outPath = resolve(repoRoot, 'web', 'lib', 'generated', 'tool-atlas.ts');
const outRel = 'web/lib/generated/tool-atlas.ts';

/**
 * Die Bereiche, in der Reihenfolge, in der sie auf der Seite stehen.
 *
 * `question` ist der Satz, mit dem jemand ankommt — nicht der Funktionsname,
 * den er sucht. Genau daran scheitern die meisten Doku-Seiten: sie sind nach
 * Bausteinen sortiert, angekommen wird aber mit einem Vorhaben.
 */
const AREAS = [
  {
    id: 'memory',
    title: 'Remember & recall',
    question: 'I want my AI to remember what we already figured out',
    tagline:
      'The core loop: store a lesson once, get it back the next time it matters — in any editor, in any session.',
    tools: [
      'learn_from_attempts',
      'smart_recall',
      'causal_trace',
      'remember_context',
      'recall_context',
      'recall_best_solution',
      'list_remembered',
      'forget_context',
      'semantic_search',
      'brain_search',
      'recall_at',
      'memory_consolidate',
      'memory_crystalize',
      'crystal_view',
      'knowledge_decay',
      'global_learn',
      'global_recall',
      'auto_learn_session',
      'compact_recover',
    ],
  },
  {
    id: 'sessions',
    title: 'Start & end a session',
    question: 'I want to pick up exactly where the last window left off',
    tagline:
      'One call in, one call out. The next session opens pre-briefed instead of asking you to explain the project again.',
    tools: [
      'session_start',
      'session_end',
      'session_handoff',
      'session_start_summary',
      'session_ping',
      'brain_briefing',
      'autopilot',
    ],
  },
  {
    id: 'codebase',
    title: 'Understand a codebase',
    question: 'I want the AI to know this repository, not just my prompt',
    tagline:
      'Turn the repo itself into memory: which files belong together, what depends on what, and who has touched it before.',
    tools: [
      'index_project',
      'brain_file_map',
      'brain_service_map',
      'trace_dependency',
      'ckg_inspect',
      'brain_graph',
      'brain_coverage',
      'brain_who_knows',
      'skill_gaps',
      'sync_file_changes',
    ],
  },
  {
    id: 'team',
    title: 'Share with your team',
    question: 'I want what one colleague learns to reach everyone else',
    tagline:
      'A shared brain with roles and scopes: your teammate debugs it once, you recall the answer.',
    tools: [
      'team_learn',
      'team_recall',
      'team_confirm',
      'team_synthesize',
      'team_crystallize',
      'team_expertise_map',
      'team_roster',
      'team_whoami',
      'team_assign_role',
      'team_grant_scope',
      'team_scopes',
      'team_audit',
      'brain_collab_pairs',
      'list_orgs',
      'create_org',
      'invite_member',
      'get_org_plan',
    ],
  },
  {
    id: 'foresight',
    title: 'Predict & plan',
    question: 'I want to know what usually goes wrong before I do it',
    tagline:
      'Ask the brain first: known failure patterns for this change, contradictions between lessons, and what is next on the plan.',
    tools: [
      'brain_predict',
      'brain_predict_failures',
      'brain_plan',
      'brain_conflicts',
      'brain_resolve_conflict',
      'madc_deliberate',
      'roadmap_next',
      'roadmap_add',
      'roadmap_update',
      'roadmap_list',
    ],
  },
  {
    id: 'cache',
    title: 'Cache data & LLM answers',
    question: 'I want to stop paying for the same answer twice',
    tagline:
      'The managed cache underneath it all: Valkey, Redis or Dragonfly, with semantic lookup for LLM responses.',
    tools: [
      'cache_get',
      'cache_set',
      'cache_delete',
      'cache_exists',
      'cache_ttl',
      'cache_keys',
      'cache_mget',
      'cache_mset',
      'cache_stats',
      'cache_org_stats',
      'cache_warmup',
      'cache_lock_acquire',
      'cache_lock_release',
      'cache_stream_get',
      'cache_stream_set',
      'detect_namespace',
      'set_cost_per_call',
    ],
  },
  {
    id: 'health',
    title: 'Keep the brain healthy',
    question: 'I want to check the memory is still worth trusting',
    tagline:
      'Memory rots quietly. These measure it, clean it, and keep feeding it from git and CI without anyone typing.',
    tools: [
      'brain_doctor',
      'brain_hygiene',
      'brain_metrics',
      'brain_changelog',
      'brain_diff',
      'brain_from_git',
      'brain_from_ci',
      'brain_confirm_ci',
      'brain_watch',
      'cls_ingest',
      'cls_install_hooks',
      'brain_portability',
      'brain_set_pref',
      'brain_get_pref',
    ],
  },
  {
    id: 'network',
    title: 'Reach beyond your team',
    question: 'I want lessons that nobody in my company has learned yet',
    tagline:
      'Publish, import and federate knowledge — including a privacy-preserving mode that shares the signal without the details.',
    tools: [
      'fedbrain_search',
      'fedbrain_contribute',
      'fedbrain_confirm',
      'fedbrain_status',
      'brain_federate',
      'brain_contribute_signal',
      'brain_import_meta',
      'brain_share',
      'brain_unshare',
      'brain_share_list',
      'brain_import',
      'brain_discover',
      'brain_seed_starter',
      'publish_lesson',
      'import_public_brain',
      'brain_marketplace',
      'brain_install',
      'syndicate',
      'syndicate_search',
      'syndicate_stats',
      'syndicate_trending',
    ],
  },
  {
    id: 'setup',
    title: 'Set up & connect',
    question: 'I want to get this running in my editor',
    tagline:
      'Instances, connection strings and the one-shot wizard that writes the config for Claude Code, Cursor, Copilot and Windsurf.',
    tools: [
      'setup_ai_memory',
      'create_instance',
      'list_instances',
      'get_instance',
      'get_connection_string',
      'get_api_status',
      'delete_instance',
    ],
  },
];

/**
 * Kuerzt eine Beschreibung auf das, was in eine Zeile passt.
 *
 * Ganze Saetze, nie mitten im Wort. Abkuerzungen wie "e.g." beenden keinen
 * Satz — sonst bricht die Zeile nach zwei Woertern ab.
 */
function toSummary(description, limit = 190) {
  const parts = description.split(/(?<=[.!?])\s+/);
  const out = [];
  for (const part of parts) {
    const candidate = [...out, part].join(' ');
    if (out.length > 0 && candidate.length > limit) break;
    out.push(part);
    if (/\b(e\.g|i\.e|vs|etc|approx|ca)\.$/i.test(part)) continue;
    if (candidate.length >= 70) break;
  }
  let text = out.join(' ').trim();
  if (text.length > limit) {
    const cut = text.slice(0, limit - 1);
    const lastSpace = cut.lastIndexOf(' ');
    text = `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
  }
  return text;
}

/** Beispielaufruf, der sich kopieren und ausfuellen laesst. */
function toSignature(tool) {
  return `${tool.name}(${tool.args.join(', ')})`;
}

export function buildAtlas() {
  const catalog = loadToolCatalog();
  const byName = new Map(catalog.tools.map((tool) => [tool.name, tool]));

  // Waechter 1: jedes zugeordnete Werkzeug muss es wirklich geben.
  // Waechter 2: kein Werkzeug darf doppelt zugeordnet sein.
  const seen = new Map();
  const unknown = [];
  for (const area of AREAS) {
    for (const name of area.tools) {
      if (!byName.has(name)) unknown.push(`${name} (listed under "${area.id}")`);
      if (seen.has(name)) unknown.push(`${name} is in both "${seen.get(name)}" and "${area.id}"`);
      seen.set(name, area.id);
    }
  }

  // Waechter 3: kein Werkzeug darf ohne Bereich bleiben. Das ist der wichtige —
  // er faengt genau den Fall ab, in dem jemand ein Werkzeug ergaenzt und die
  // Doku still einen Eintrag weniger zeigt, ohne dass irgendwo etwas rot wird.
  const orphans = catalog.tools.filter((tool) => !seen.has(tool.name)).map((tool) => tool.name);

  if (unknown.length > 0 || orphans.length > 0) {
    const lines = ['docs-atlas: the area map and sdk/mcp/src/tools.ts disagree.'];
    if (orphans.length > 0) {
      lines.push(
        `  ${orphans.length} tool(s) have no area — add them to AREAS in scripts/docs-atlas.mjs:`,
        ...orphans.map((name) => `    - ${name}`),
      );
    }
    if (unknown.length > 0) {
      lines.push('  broken entries in the area map:', ...unknown.map((line) => `    - ${line}`));
    }
    throw new Error(lines.join('\n'));
  }

  const areas = AREAS.map((area) => ({
    id: area.id,
    title: area.title,
    question: area.question,
    tagline: area.tagline,
    tools: area.tools.map((name) => {
      const tool = byName.get(name);
      const summary = toSummary(tool.description);
      return {
        name: tool.name,
        summary,
        signature: toSignature(tool),
        args: tool.args,
        // Die Suche liest den GANZEN Beschreibungstext, angezeigt wird nur die
        // gekuerzte Zeile. Sonst findet "cursor" genau einen Treffer, obwohl
        // vier Stellen davon reden — der Rest faellt der Kuerzung zum Opfer.
        // Nur der Teil, der nicht ohnehin schon in summary steht.
        searchText: tool.description.startsWith(summary.replace(/…$/, ''))
          ? tool.description.slice(summary.replace(/…$/, '').length).trim()
          : tool.description,
      };
    }),
  }));

  return { totalTools: catalog.total_tools, areas };
}

function render(atlas) {
  return `// GENERATED FILE — do not edit by hand.
// Source of truth: sdk/mcp/src/tools.ts
// Regenerate:      cd sdk/mcp && npm run docs-atlas:write
// Verified by:     npm run verify-docs-atlas (fails if a tool has no area)

export type AtlasTool = {
  /** MCP tool name, exactly as the server exposes it. */
  name: string;
  /** First sentences of the tool description, trimmed to one line. */
  summary: string;
  /** Copy-ready call with the required arguments, e.g. smart_recall(instance_id, query). */
  signature: string;
  /** Required argument names, in schema order. */
  args: string[];
  /**
   * The rest of the tool description, beyond what \`summary\` already shows.
   * Searched but never rendered — so a query still matches a tool whose
   * relevant sentence sits below the fold of the summary.
   */
  searchText: string;
};

/**
 * The area ids, as a union. Hand-written code that points at an area (the
 * guide list on the docs page) uses this type, so a typo is a build error
 * instead of an entry that silently renders nowhere.
 */
export type AreaId = ${atlas.areas.map((area) => `'${area.id}'`).join(' | ')};

export type AtlasArea = {
  id: AreaId;
  title: string;
  /** The sentence a visitor arrives with, in plain language. */
  question: string;
  tagline: string;
  tools: AtlasTool[];
};

/** Total number of MCP tools the server exposes. */
export const TOTAL_TOOLS = ${atlas.totalTools};

export const AREAS: AtlasArea[] = ${JSON.stringify(atlas.areas, null, 2)};

/** Flat list, for search across every area at once. */
export const ALL_TOOLS: (AtlasTool & { areaId: string; areaTitle: string })[] = AREAS.flatMap(
  (area) => area.tools.map((tool) => ({ ...tool, areaId: area.id, areaTitle: area.title })),
);
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'summary';
  const atlas = buildAtlas();
  const rendered = render(atlas);

  switch (command) {
    case 'write':
      writeFileSync(outPath, rendered);
      console.log(`docs-atlas: wrote ${outRel} (${atlas.totalTools} tools, ${atlas.areas.length} areas).`);
      break;
    case 'check': {
      let current = '';
      try {
        current = readFileSync(outPath, 'utf8');
      } catch {
        console.error(`docs-atlas: ${outRel} is missing. Run: npm run docs-atlas:write`);
        process.exit(1);
      }
      if (current !== rendered) {
        console.error(`docs-atlas: ${outRel} is stale. Run: npm run docs-atlas:write`);
        process.exit(1);
      }
      console.log(`docs-atlas: ${outRel} is up to date (${atlas.totalTools} tools).`);
      break;
    }
    case 'summary':
      console.log(`total_tools=${atlas.totalTools}`);
      for (const area of atlas.areas) console.log(`${area.id}: ${area.tools.length}`);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
