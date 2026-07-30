import { createHmac } from 'node:crypto';
import type { Redis } from 'ioredis';
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge,
         ckgUpsertPersonNode, ckgUpsertFileNode, ckgRecordCollaboration } from '../ckg.js';
import type { CKGEdge, CKGNode } from '../ckg.js';
import { safeJsonParse, normalizeGitPath } from '../utils.js';
import { buildClsPostCommitHook } from '../cls-hook.js';
import { installBrainWatchHook } from '../brain-watch-hook.js';
import { keywordSearch } from '../search.js';
import { buildFirstContactReport, suggestRecallQueries, type FirstContactProof } from '../first-contact.js';

// Last brain_from_git category counts — set after each run so index.ts can include them in telemetry
export let _lastBrainFromGitCounts: { fixes: number; features: number; refactors: number; total: number } | null = null;

// Last brain_from_ci counts — set after each run so index.ts can include them in telemetry
export let _lastBrainFromCiCounts: { fixes: number; breaks: number; stable: number; total: number } | null = null;

// Git concurrency semaphore (for brain_from_git parallel workers)
let _gitSemCount = 0;
const _GIT_SEM_MAX = 10;
const _gitSemQueue: Array<() => void> = [];
function _gitSemAcquire(): Promise<void> {
  if (_gitSemCount < _GIT_SEM_MAX) { _gitSemCount++; return Promise.resolve(); }
  return new Promise(resolve => _gitSemQueue.push(resolve));
}
function _gitSemRelease(): void {
  const next = _gitSemQueue.shift();
  if (next) { next(); } else { _gitSemCount--; }
}

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const FEDBRAIN_TOOL_NAMES = new Set([
  'madc_deliberate', 'cls_ingest', 'cls_install_hooks', 'fedbrain_contribute', 'fedbrain_search',
  'fedbrain_confirm', 'fedbrain_status', 'brain_federate', 'crystal_view', 'compact_recover',
  'brain_from_git', 'brain_from_ci', 'brain_predict_failures',
  'brain_contribute_signal', 'brain_import_meta', 'brain_watch',
]);

export async function handleFedbrainTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
    case 'madc_deliberate': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      const historyRaw = await redis.lrange(`cachly:lessons:${topic}`, 0, -1);
      const history = historyRaw.map(r => { try { return JSON.parse(r) as { outcome: string; what_worked?: string; what_failed?: string; ts?: string }; } catch { return null; } }).filter(Boolean) as Array<{ outcome: string; what_worked?: string; what_failed?: string; ts?: string }>;

      if (history.length < 2) {
        return [
          `🗳️ **MADC: "${topic}"**`, '',
          `Not enough history for deliberation (need ≥ 2 entries, found ${history.length}).`,
          '', `Call \`learn_from_attempts\` with conflicting outcomes to trigger deliberation.`,
        ].join('\n');
      }

      // Specialist agents and their domain keywords
      const AGENTS = [
        { name: 'InfraAgent',    domains: ['infra', 'k8s', 'docker', 'server', 'wireguard', 'helm'] },
        { name: 'AuthAgent',     domains: ['auth', 'jwt', 'keycloak', 'oauth', 'oidc', 'token'] },
        { name: 'DeployAgent',   domains: ['deploy', 'ci', 'pipeline', 'rsync', 'release'] },
        { name: 'DatabaseAgent', domains: ['db', 'gorm', 'migration', 'postgres', 'clickhouse', 'redis'] },
        { name: 'DebugAgent',    domains: ['debug', 'panic', 'race', 'nil', 'fix', 'error'] },
        { name: 'APIAgent',      domains: ['api', 'http', 'grpc', 'rest', 'fiber', 'web'] },
      ];

      const topicDomain = topic.split(':')[0] ?? '';
      const relevantAgents = AGENTS.filter(a => a.domains.some(d => topicDomain === d || topic.includes(d)));
      const votingAgents = relevantAgents.length > 0 ? relevantAgents : AGENTS;

      // Measure each agent's CKG coverage in their domains
      const agentCoverage = new Map<string, number>();
      for (const agent of votingAgents) {
        let edgeCount = 0;
        for (const domain of agent.domains) {
          const nodeKeys: string[] = [];
          const nStream = redis.scanStream({ match: `cachly:ckg:node:${domain}*`, count: 50 });
          await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });
          edgeCount += nodeKeys.length;
        }
        agentCoverage.set(agent.name, edgeCount);
      }

      const successLessons = history.filter(l => l.outcome === 'success' || l.outcome === 'partial');
      const failureLessons = history.filter(l => l.outcome === 'failure');

      if (failureLessons.length === 0) {
        return [
          `🗳️ **MADC: "${topic}"**`, '',
          `No contradictions found — all ${successLessons.length} entries have non-failure outcomes.`,
          '', `Use \`ckg_inspect(concept="${ckgSlug(topic)}")\` to explore the confidence graph.`,
        ].join('\n');
      }

      // Agent voting logic
      const votes: Array<{ agent: string; vote: 'success' | 'failure' | 'abstain'; coverage: number; reason: string }> = [];
      for (const agent of votingAgents) {
        const coverage = agentCoverage.get(agent.name) ?? 0;
        let vote: 'success' | 'failure' | 'abstain';
        let reason: string;
        if (coverage < 2) {
          vote = 'abstain'; reason = 'insufficient domain coverage';
        } else if (successLessons.length >= failureLessons.length * 2) {
          vote = 'success'; reason = `${successLessons.length}/${history.length} entries confirm success`;
        } else if (failureLessons.length >= successLessons.length * 2) {
          vote = 'failure'; reason = `${failureLessons.length}/${history.length} entries confirm failure`;
        } else {
          vote = 'abstain'; reason = `contested (${successLessons.length} success vs ${failureLessons.length} failure)`;
        }
        votes.push({ agent: agent.name, vote, coverage, reason });
      }

      const successVotes = votes.filter(v => v.vote === 'success').length;
      const failureVotes = votes.filter(v => v.vote === 'failure').length;
      const abstainVotes = votes.filter(v => v.vote === 'abstain').length;

      let resolution: 'unanimous_success' | 'unanimous_failure' | 'contested';
      let resolutionText: string;
      if (successVotes > 0 && failureVotes === 0) {
        resolution = 'unanimous_success';
        resolutionText = `✅ **Unanimous: SUCCESS** — ${successVotes} agent(s) confirm, ${abstainVotes} abstain`;
      } else if (failureVotes > 0 && successVotes === 0) {
        resolution = 'unanimous_failure';
        resolutionText = `❌ **Unanimous: FAILURE** — ${failureVotes} agent(s) confirm, ${abstainVotes} abstain`;
      } else {
        resolution = 'contested';
        resolutionText = `⚠️ **CONTESTED** — ${successVotes} success votes, ${failureVotes} failure votes, ${abstainVotes} abstain`;
      }

      // Store resolution as CKG node
      const resNodeId = ckgSlug(`resolution:${topic}`);
      const resNode = {
        id: resNodeId, domain: 'resolution', type: 'resolution', count: 1,
        ts: new Date().toISOString(), resolution, topic,
        votes: { success: successVotes, failure: failureVotes, abstain: abstainVotes },
      };
      await redis.set(`cachly:ckg:node:${resNodeId}`, JSON.stringify(resNode));

      // Write contradicts edge if contested; decay loser confidence to 0.1 if unanimous
      if (resolution === 'contested') {
        await ckgUpdateEdge(redis, ckgSlug(topic), 'contradicts', resNodeId, false);
      } else {
        // Unanimous — demote the losing side's edges to near-zero confidence
        const loserOutcome = resolution === 'unanimous_success' ? 'failure' : 'success';
        const loserLessons = (loserOutcome === 'failure' ? failureLessons : successLessons);
        if (loserLessons.length > 0) {
          // Decay all 'fixes' edges from this concept that contradict the resolution
          const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${ckgSlug(topic)}`);
          for (const fk of fromKeys) {
            const er = await redis.get(fk);
            if (!er) continue;
            try {
              const edge: CKGEdge = JSON.parse(er);
              if (edge.edgeType === 'fixes' && edge.confidence > 0.15) {
                if (resolution === 'unanimous_failure') {
                  // Fix was wrong — decay to 0.1
                  edge.confidence = 0.1;
                  edge.last_updated = new Date().toISOString();
                  await redis.set(fk, JSON.stringify(edge));
                }
              }
            } catch { /* skip corrupt edges */ }
          }
        }
        // Remove the conflict marker — deliberation resolved it
        await redis.del(`cachly:ckg:conflict:${ckgSlug(topic)}`);
      }

      const lines = [
        `🗳️ **MADC Deliberation: "${topic}"**`, '',
        `📊 Evidence: ${successLessons.length} success/partial vs ${failureLessons.length} failure entries (${history.length} total)`,
        '', `**Voting agents (${votingAgents.length}):**`,
        ...votes.map(v => {
          const icon = v.vote === 'success' ? '✅' : v.vote === 'failure' ? '❌' : '⬜';
          const covBar = '▓'.repeat(Math.min(v.coverage, 5)) + '░'.repeat(Math.max(0, 5 - v.coverage));
          return `  ${icon} **${v.agent}** [${covBar}] ${v.coverage} CKG edges — ${v.reason}`;
        }),
        '', resolutionText, '',
      ];

      if (resolution === 'unanimous_success') {
        lines.push(`🔧 Failure entries superseded — store confirmed lesson: \`learn_from_attempts(topic="${topic}", outcome="success", ...)\``);
      } else if (resolution === 'unanimous_failure') {
        lines.push(`🚫 Success claims unconfirmed — re-verify: \`recall_best_solution(topic="${topic}")\``);
      } else {
        lines.push(`⚠️ Contested — run \`causal_trace\` before acting. Explore: \`ckg_inspect(concept="${ckgSlug(topic)}")\``);
      }

      lines.push('', `📝 Resolution node: \`cachly:ckg:node:${resNodeId}\``);
      return lines.join('\n');
    }

    // ── Layer 5: CLS — cls_ingest ─────────────────────────────────────────────
    case 'cls_ingest': {
      const { instance_id, source, payload } = args as {
        instance_id: string;
        source: 'git_commit' | 'ci_outcome' | 'ide_diagnostic';
        payload: Record<string, unknown>;
      };
      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();
      const clsKey = 'cachly:cls:events';

      if (source === 'git_commit') {
        const message = String(payload.message ?? '');
        const sha = String(payload.sha ?? '');
        const files = (Array.isArray(payload.files) ? payload.files : []) as string[];

        const domain = /^fix/i.test(message) ? 'fix' : /^feat/i.test(message) ? 'feat' : /^refactor/i.test(message) ? 'refactor' : /^test/i.test(message) ? 'test' : 'commit';
        const slug = `${domain}:${ckgSlug(message.slice(0, 60))}`;
        const conceptId = ckgSlug(slug);

        await ckgUpsertNode(redis, conceptId, domain, 'commit');
        for (const f of files.slice(0, 10)) {
          const fd = f.includes('auth') ? 'auth' : f.includes('api') ? 'api' : f.includes('infra') ? 'infra' : f.includes('web') ? 'web' : 'code';
          const fileId = ckgSlug(`file:${fd}`);
          await ckgUpsertNode(redis, fileId, 'file', fd);
          await ckgUpdateEdge(redis, conceptId, 'co-occurs', fileId, true);
        }

        const lessonObj = {
          topic: slug, outcome: 'success' as const, what_worked: message, what_failed: '',
          context: `CLS/git: sha=${sha}`, severity: 'minor' as const,
          file_paths: files.slice(0, 10), commands: sha ? [`git show ${sha}`] : [],
          tags: ['cls', 'git'], depends_on: [], recall_count: 0, ts, verified_at: ts,
          confidence: 0.6, audit_trail: [{ ts, action: 'cls_git_commit' }], version: 3,
        };
        await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
        const existing = await redis.get(`cachly:lesson:best:${slug}`);
        if (!existing) await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { message, sha }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        return [
          `📨 **CLS Ingested: git_commit**`, '',
          `Commit \`${sha.slice(0, 8) || '?'}\`: ${message.slice(0, 80)}`,
          `Concept: \`${conceptId}\` (${domain}) · Files: ${files.length}`,
          '', `🕸️ CKG: \`${conceptId}\` + ${files.length} file edges · Lesson: \`${slug}\``,
          `💡 Inspect: \`ckg_inspect(concept="${domain}")\``,
        ].join('\n');
      }

      if (source === 'ci_outcome') {
        const status = String(payload.status ?? '');
        const prev_status = String(payload.prev_status ?? '');
        const job = String(payload.job ?? 'unknown');
        const ciCtx = String(payload.context ?? '');

        const isFixed = ['failure', 'red', 'error'].includes(prev_status) && ['success', 'green', 'passed'].includes(status);
        const isBroken = ['success', 'green', 'passed'].includes(prev_status) && ['failure', 'red', 'error'].includes(status);

        const slug = `ci:${ckgSlug(job)}`;
        const conceptId = ckgSlug(slug);
        await ckgUpsertNode(redis, conceptId, 'ci', 'job');

        if (isFixed) {
          const problemId = ckgSlug(`problem:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, problemId, 'problem', 'ci-failure');
          await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, true);
          const lessonObj = {
            topic: slug, outcome: 'success' as const,
            what_worked: `CI job "${job}" went ${prev_status} → ${status}`,
            what_failed: `Job "${job}" was failing`, context: `CLS/ci: ${ciCtx}`,
            severity: 'major' as const, file_paths: [], commands: [], tags: ['cls', 'ci'],
            depends_on: [], recall_count: 0, ts, verified_at: ts, confidence: 0.75,
            audit_trail: [{ ts, action: 'cls_ci_fixed' }], version: 3,
          };
          await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
          await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));
        } else if (isBroken) {
          const causeId = ckgSlug(`cause:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, causeId, 'cause', 'ci-break');
          await ckgUpdateEdge(redis, conceptId, 'causes', causeId, false);
        }

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { status, prev_status, job }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        const statusIcon = isFixed ? '✅ Fixed' : isBroken ? '🔴 Broken' : '📊 Recorded';
        return [
          `📨 **CLS Ingested: ci_outcome**`, '',
          `${statusIcon}: \`${job}\` — ${prev_status || '?'} → ${status}`,
          isFixed ? `🔧 CKG \`fixes\` edge added (75% confidence)` : isBroken ? `⚡ CKG \`causes\` edge added` : `📊 State recorded`,
          `💡 Lesson: \`${slug}\`  |  Predict: \`brain_predict(context="${job}")\``,
        ].join('\n');
      }

      if (source === 'ide_diagnostic') {
        const error = String(payload.error ?? '');
        const fix = String(payload.fix ?? '');
        const file = String(payload.file ?? '');

        const errorConcept = extractProblemConcept(error) ?? 'unknown-error';
        const slug = `debug:${ckgSlug(errorConcept)}`;
        const conceptId = ckgSlug(slug);
        const problemId = ckgSlug(`problem:${errorConcept}`);

        await ckgUpsertNode(redis, conceptId, 'debug', 'diagnostic');
        await ckgUpsertNode(redis, problemId, 'problem', 'compiler-error');
        await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, true);

        const lessonObj = {
          topic: slug, outcome: 'success' as const, what_worked: fix, what_failed: error,
          context: `CLS/ide: ${file}`, severity: 'minor' as const,
          file_paths: file ? [file] : [], commands: [], tags: ['cls', 'ide-diagnostic'],
          depends_on: [], recall_count: 0, ts, verified_at: ts, confidence: 0.65,
          audit_trail: [{ ts, action: 'cls_ide_diagnostic' }], version: 3,
        };
        await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
        const existingL = await redis.get(`cachly:lesson:best:${slug}`);
        if (!existingL) await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { error: error.slice(0, 60), fix: fix.slice(0, 60), file }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        return [
          `📨 **CLS Ingested: ide_diagnostic**`, '',
          `Error: \`${error.slice(0, 80)}\``,
          `Fix: ${fix.slice(0, 100)}`,
          file ? `File: \`${file}\`` : '',
          '', `🕸️ CKG: \`${conceptId}\` → fixes → \`${problemId}\`  |  Lesson: \`${slug}\``,
        ].filter(l => l !== '').join('\n');
      }

      return `❌ Unknown CLS source: "${source}". Valid: git_commit, ci_outcome, ide_diagnostic`;
    }

    // ── Layer 5: CLS — cls_install_hooks ─────────────────────────────────────
    case 'cls_install_hooks': {
      const { instance_id, repo_path = '.', hooks = ['git', 'ci'] } = args as {
        instance_id: string; repo_path?: string; hooks?: string[];
      };
      const hooksArr = Array.isArray(hooks) ? hooks : ['git', 'ci'];
      const lines: string[] = [`🔌 **CLS Hook Installation Guide**\n`];

      if (hooksArr.includes('git')) {
        const hookScript = buildClsPostCommitHook(instance_id);

        lines.push(`### Git post-commit hook`);
        lines.push(`**Quick install (run once per repo):**`);
        lines.push('```sh');
        lines.push(`cat > ${repo_path}/.git/hooks/post-commit << 'HOOK'`);
        lines.push(hookScript);
        lines.push(`HOOK`);
        lines.push(`chmod +x ${repo_path}/.git/hooks/post-commit`);
        lines.push('```');
        lines.push(`After install: every \`git commit\` automatically updates your brain's CKG.`);
        lines.push('');
      }

      if (hooksArr.includes('ci')) {
        lines.push(`### GitHub Actions CI outcome hook`);
        lines.push(`**Add at the end of each job** (after build/test steps):`);
        lines.push('```yaml');
        lines.push(`- name: cachly CLS — record CI outcome`);
        lines.push(`  if: always()`);
        lines.push(`  run: |`);
        lines.push(`    node -e "`);
        lines.push(`    const r=require('https');`);
        lines.push(`    const d=JSON.stringify({instance_id:'${instance_id}',source:'ci_outcome',payload:{`);
        lines.push(`      status:'\${{ job.status }}',prev_status:'unknown',job:'\${{ github.job }}',`);
        lines.push(`      context:'github-actions run \${{ github.run_number }}'}});`);
        lines.push(`    r.request({hostname:'api.cachly.dev',path:'/api/v1/cls/ingest',method:'POST',`);
        lines.push(`      headers:{'Content-Type':'application/json','Authorization':'Bearer $CACHLY_JWT',`);
        lines.push(`        'Content-Length':d.length}},()=>{}).end(d);`);
        lines.push(`    " 2>/dev/null || true`);
        lines.push(`  env:`);
        lines.push(`    CACHLY_JWT: \${{ secrets.CACHLY_JWT }}`);
        lines.push('```');
        lines.push('');
      }

      lines.push(`💡 Once installed: \`brain_search(query="cls")\` to verify events are arriving.`);
      lines.push(`📊 Monitor CKG growth: \`ckg_inspect(concept="ci")\` or \`ckg_inspect(concept="fix")\``);
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_contribute ───────────────────────────────
    case 'fedbrain_contribute': {
      const { instance_id, lesson_key, visibility = 'public' } = args as {
        instance_id: string; lesson_key: string; visibility?: string;
      };
      const redis = await getConnection(instance_id);

      const raw = await redis.get(`cachly:lesson:best:${lesson_key}`);
      if (!raw) return `❌ Lesson \`${lesson_key}\` not found. Store it first with \`learn_from_attempts\`.`;

      const lesson = safeJsonParse(raw, null as null | { topic: string; outcome: string; what_worked: string; what_failed?: string; tags?: string[]; commands?: string[]; severity?: string; ts?: string });
      if (!lesson) return `❌ Lesson \`${lesson_key}\` data is corrupted. Re-store with \`learn_from_attempts\`.`;

      const domainTokens = [lesson.topic.split(':')[0], ...(lesson.tags ?? [])].filter(Boolean);
      const domainFingerprint = [...new Set(domainTokens)].sort().join(',');

      // HMAC certificate ID (non-reversible, privacy-safe)
      const certContent = `${lesson.topic}:${lesson.outcome}:${lesson.what_worked}`;
      const certId = createHmac('sha256', `cachly-fedbrain:${instance_id}`).update(certContent).digest('hex').slice(0, 16);

      const cert = {
        cert_id: certId, lesson_key, visibility,
        domain_fingerprint: domainFingerprint,
        contributed_at: new Date().toISOString(),
        confirm_count: 0,
        trust_score: lesson.outcome === 'success' ? 0.85 : 0.5,
      };
      await redis.set(`cachly:fedbrain:cert:${certId}`, JSON.stringify(cert));
      await redis.sadd('cachly:fedbrain:contributed', certId);

      // Try global commons via syndication API
      let syndicationResult: string;
      try {
        await apiFetch('/api/v1/syndication/contribute', {
          method: 'POST',
          body: JSON.stringify({
            topic: lesson.topic, outcome: lesson.outcome,
            what_worked: lesson.what_worked, what_failed: lesson.what_failed ?? '',
            severity: lesson.severity ?? 'major', cert_id: certId,
            domain_fingerprint: domainFingerprint, visibility,
          }),
        });
        syndicationResult = `✅ Contributed to global commons`;
      } catch {
        syndicationResult = `📦 Stored locally (commons API unavailable — will sync when online)`;
      }

      return [
        `🌐 **FedBrain Contribute: "${lesson_key}"**`, '',
        `📜 Certificate: \`${certId}\``,
        `🏷️ Domain fingerprint: ${domainTokens.slice(0, 6).map(t => `\`${t}\``).join(', ')}`,
        `🔒 Visibility: ${visibility}`,
        '', syndicationResult, '',
        `💡 At 10 independent confirms → 🏆 Gold Standard`,
        `🔍 Search: \`fedbrain_search(query="${lesson.topic.split(':').slice(-1)[0]}")\``,
      ].join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_search ──────────────────────────────────
    case 'fedbrain_search': {
      const { instance_id, query, context_hints = [], limit = 10 } = args as {
        instance_id: string; query: string; context_hints?: string[]; limit?: number;
      };
      const redis = await getConnection(instance_id);

      // Build local domain context from contributed certificates + explicit hints
      const contribIds = await redis.smembers('cachly:fedbrain:contributed');
      const localDomains = new Map<string, number>();
      for (const certId of contribIds.slice(0, 30)) {
        const certRaw = await redis.get(`cachly:fedbrain:cert:${certId}`);
        if (!certRaw) continue;
        try {
          const cert = JSON.parse(certRaw) as { domain_fingerprint?: string };
          for (const d of (cert.domain_fingerprint ?? '').split(',').filter(Boolean)) {
            localDomains.set(d, (localDomains.get(d) ?? 0) + 1);
          }
        } catch { /* skip */ }
      }
      for (const hint of (Array.isArray(context_hints) ? context_hints : [])) {
        localDomains.set(hint.toLowerCase(), (localDomains.get(hint.toLowerCase()) ?? 0) + 2);
      }

      // Search global commons
      type SynResult = { id: string; topic: string; category: string; outcome: string; what_worked: string; what_failed?: string; severity: string; confirm_count: number; created_at: string; domain_fingerprint?: string };
      let results: SynResult[] = [];
      try {
        const params = new URLSearchParams({ q: query, limit: String(Math.min((limit as number) * 2, 50)) });
        const res = await apiFetch<{ results: SynResult[]; count: number }>(`/api/v1/syndication/search?${params}`);
        results = res.results ?? [];
      } catch {
        // Fallback: search local lessons
        const lessonKeys: string[] = [];
        const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
        await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });
        for (const k of lessonKeys.slice(0, 60)) {
          const r = await redis.get(k);
          if (!r) continue;
          try {
            const l = JSON.parse(r) as { topic: string; outcome: string; what_worked?: string; what_failed?: string; severity?: string; ts?: string };
            const haystack = `${l.topic} ${l.what_worked ?? ''} ${l.what_failed ?? ''}`.toLowerCase();
            if (query.toLowerCase().split(/\s+/).some(t => t.length > 2 && haystack.includes(t))) {
              results.push({ id: k.split(':').pop() ?? k, topic: l.topic, category: l.topic.split(':')[0], outcome: l.outcome, what_worked: l.what_worked ?? '', severity: l.severity ?? 'major', confirm_count: 0, created_at: l.ts ?? new Date().toISOString() });
            }
          } catch { /* skip */ }
        }
      }

      if (results.length === 0) {
        return [`🌐 **FedBrain Search: "${query}"**`, '', `No results. Contribute: \`fedbrain_contribute(lesson_key="fix:...")\``].join('\n');
      }

      // Context-weighted ranking
      const ranked = results.map(r => {
        const rDomains = (r.domain_fingerprint ?? r.category ?? '').split(',').filter(Boolean);
        const overlap = rDomains.reduce((s, d) => s + (localDomains.get(d) ?? 0), 0);
        const contextScore = localDomains.size > 0 ? overlap / Math.max(1, localDomains.size + rDomains.length) : 0;
        const confirmedScore = Math.min(1, r.confirm_count / 10);
        const weightedScore = (contextScore * 0.4) + (confirmedScore * 0.4) + (r.outcome === 'success' ? 0.2 : 0);
        return { ...r, weightedScore, isGoldStandard: r.confirm_count >= 10 };
      }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit as number);

      const lines = [`🌐 **FedBrain Search: "${query}"** — ${ranked.length} result${ranked.length !== 1 ? 's' : ''} (context-weighted)\n`];
      for (const r of ranked) {
        const icon = r.outcome === 'success' ? '✅' : r.outcome === 'failure' ? '❌' : '⚠️';
        const goldBadge = r.isGoldStandard ? ' 🏆 _Gold Standard_' : r.confirm_count >= 3 ? ` ✓${r.confirm_count}` : '';
        const ctxPct = Math.round(r.weightedScore * 100);
        lines.push(`${icon}${goldBadge} **\`${r.topic}\`** [ctx: ${ctxPct}%]`);
        if (r.what_worked) lines.push(`  ✅ ${r.what_worked.slice(0, 150)}`);
        if (r.what_failed) lines.push(`  ❌ ${r.what_failed.slice(0, 80)}`);
        lines.push(`  _${r.confirm_count} confirm${r.confirm_count !== 1 ? 's' : ''}  |  id: \`${r.id}\`_`, '');
      }
      if (localDomains.size > 0) {
        const topDomains = [...localDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `\`${d}\`(${n})`).join(', ');
        lines.push(`🎯 Your context: ${topDomains}`);
      }
      lines.push(`💡 Confirm a result: \`fedbrain_confirm(id="<id>", topic="<topic>", outcome="worked")\``);
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_confirm ─────────────────────────────────
    case 'fedbrain_confirm': {
      // The commons confirm endpoint keys on the syndicated lesson id
      // (POST /api/v1/syndication/:id/confirm). `id` comes from fedbrain_search
      // results; `topic` is kept for the LOCAL CKG confidence edge and display.
      const { instance_id, id, topic, outcome } = args as {
        instance_id: string; id?: string; topic?: string;
        outcome: 'worked' | 'partially_worked' | 'did_not_work';
      };
      if (!id) {
        return [
          `❌ **FedBrain Confirm** needs the lesson \`id\` from \`fedbrain_search\` results.`,
          `Run \`fedbrain_search(query="...")\`, copy the id shown next to a result,`,
          `then: \`fedbrain_confirm(id="<id>", topic="<topic>", outcome="worked")\`.`,
        ].join('\n');
      }
      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      const confirmEntry = JSON.stringify({ id, topic, outcome, ts });
      await redis.rpush('cachly:fedbrain:confirmations', confirmEntry);
      await redis.ltrim('cachly:fedbrain:confirmations', -200, -1);

      // Update local CKG confidence (only when we know which topic this maps to).
      const worked = outcome === 'worked';
      const partial = outcome === 'partially_worked';
      if (topic) {
        await ckgUpdateEdge(redis, ckgSlug(topic), 'fixes', ckgSlug(`syndicated:${topic}`), worked, partial);
      }

      // Propagate to global commons — id in the PATH, body ignored server-side.
      let propResult: string;
      try {
        await apiFetch(`/api/v1/syndication/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
        propResult = `✅ Confirmation propagated to global commons`;
      } catch {
        await redis.rpush('cachly:fedbrain:pending_confirms', confirmEntry);
        await redis.ltrim('cachly:fedbrain:pending_confirms', -50, -1);
        propResult = `📦 Queued locally (API unavailable — will propagate on next online session)`;
      }

      const icon = worked ? '✅' : partial ? '⚠️' : '❌';
      const label = topic ?? id;
      return [
        `${icon} **FedBrain Confirm: "${label}"** → ${outcome}`, '',
        propResult, '',
        topic
          ? `🕸️ CKG confidence ${worked || partial ? 'boosted' : 'reduced'} for \`${ckgSlug(topic)}\``
          : `🕸️ Local CKG unchanged (pass \`topic\` to also update your own confidence graph)`,
        `💡 Your confirmation helps other brains worldwide.`,
        `📊 Status: \`fedbrain_status(instance_id="...")\``,
      ].join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_status ──────────────────────────────────
    case 'fedbrain_status': {
      const { instance_id } = args as { instance_id: string };
      const redis = await getConnection(instance_id);

      const contribIds = await redis.smembers('cachly:fedbrain:contributed');
      const confirmsRaw = await redis.lrange('cachly:fedbrain:confirmations', -10, -1);
      const pendingConfirms = await redis.llen('cachly:fedbrain:pending_confirms');
      const confirms = confirmsRaw.map(r => { try { return JSON.parse(r) as { topic: string; outcome: string; ts: string }; } catch { return null; } }).filter(Boolean) as Array<{ topic: string; outcome: string; ts: string }>;

      const certDetails: Array<{ cert_id: string; lesson_key: string; confirm_count: number; trust_score: number; isGold: boolean }> = [];
      for (const certId of contribIds.slice(0, 15)) {
        const raw = await redis.get(`cachly:fedbrain:cert:${certId}`);
        if (!raw) continue;
        try {
          const cert = JSON.parse(raw) as { cert_id: string; lesson_key: string; confirm_count?: number; trust_score?: number };
          certDetails.push({ cert_id: cert.cert_id, lesson_key: cert.lesson_key, confirm_count: cert.confirm_count ?? 0, trust_score: cert.trust_score ?? 0.5, isGold: (cert.confirm_count ?? 0) >= 10 });
        } catch { /* skip */ }
      }

      const lines = [
        `🌐 **FedBrain Status**\n`,
        `### 📤 Contributed Lessons: ${contribIds.length}`,
      ];

      if (certDetails.length > 0) {
        for (const c of certDetails) {
          const goldBadge = c.isGold ? ' 🏆 Gold Standard' : '';
          const confBar = '█'.repeat(Math.min(10, c.confirm_count)) + '░'.repeat(Math.max(0, 10 - c.confirm_count));
          lines.push(`  \`${c.lesson_key}\` [${confBar}] ×${c.confirm_count}${goldBadge}`);
        }
      } else {
        lines.push(`  _None yet. Contribute with \`fedbrain_contribute(lesson_key="fix:...")\`_`);
      }

      lines.push('', `### 📥 Recent Confirmations: ${confirms.length}`);
      if (confirms.length > 0) {
        for (const c of confirms.slice(-5)) {
          const icon = c.outcome === 'worked' ? '✅' : c.outcome === 'partially_worked' ? '⚠️' : '❌';
          lines.push(`  ${icon} \`${c.topic}\` — ${c.outcome} (${new Date(c.ts).toLocaleDateString('de-DE')})`);
        }
      } else {
        lines.push(`  _None yet. Confirm syndicated lessons with \`fedbrain_confirm\`_`);
      }

      if (pendingConfirms > 0) {
        lines.push('', `⚠️ ${pendingConfirms} confirmation${pendingConfirms !== 1 ? 's' : ''} pending propagation`);
      }

      lines.push('', '---',
        `**Contribute:** \`fedbrain_contribute(lesson_key="fix:...")\``,
        `**Search:** \`fedbrain_search(query="...")\``,
        `**Confirm:** \`fedbrain_confirm(id="...", topic="...", outcome="worked")\``,
      );
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — brain_federate ───────────────────────────────────
    case 'brain_federate': {
      const { instance_id, source, domain, min_confidence = 0.6, dry_run = false } = args as {
        instance_id: string; source: string; domain: string;
        min_confidence?: number; dry_run?: boolean;
      };
      if (instance_id === source) return `❌ Source and destination cannot be the same brain.`;

      const destRedis = await getConnection(instance_id);
      const srcRedis = await getConnection(source);

      const domainPattern = domain === '*' ? 'cachly:ckg:node:*' : `cachly:ckg:node:${domain}*`;

      // Scan source CKG nodes matching the domain
      const nodeKeys: string[] = [];
      const nStream = srcRedis.scanStream({ match: domainPattern, count: 100 });
      await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

      if (nodeKeys.length === 0) {
        return [
          `🧠 **brain_federate: "${domain}"**`, '',
          `No CKG nodes found in source brain for domain \`${domain}\`.`,
          `The source brain may not have knowledge in this area yet.`,
          `Try: \`fedbrain_search(query="${domain}")\` to find global commons knowledge instead.`,
        ].join('\n');
      }

      // Transfer nodes + their outgoing edges
      let nodesTransferred = 0;
      let edgesTransferred = 0;
      let lessonsTransferred = 0;
      let skippedLowConf = 0;
      const transferLog: string[] = [];

      for (const nk of nodeKeys) {
        const nodeRaw = await srcRedis.get(nk);
        if (!nodeRaw) continue;
        let node: CKGNode;
        try { node = JSON.parse(nodeRaw); } catch { continue; }

        if (!dry_run) await destRedis.set(nk, nodeRaw);
        nodesTransferred++;

        // Transfer outgoing edges for this node
        const edgeKeys = await srcRedis.smembers(`cachly:ckg:idx:from:${node.id}`);
        for (const ek of edgeKeys) {
          const edgeRaw = await srcRedis.get(ek);
          if (!edgeRaw) continue;
          let edge: CKGEdge;
          try { edge = JSON.parse(edgeRaw); } catch { continue; }
          if (edge.confidence < (min_confidence as number)) { skippedLowConf++; continue; }
          if (!dry_run) {
            await destRedis.set(ek, edgeRaw);
            await destRedis.sadd(`cachly:ckg:idx:from:${edge.from}`, ek);
            await destRedis.sadd(`cachly:ckg:idx:to:${edge.to}`, ek);
          }
          edgesTransferred++;
        }

        // Transfer best-lesson for the same topic slug
        const lessonKey = `cachly:lesson:best:${node.id}`;
        const lessonRaw = await srcRedis.get(lessonKey);
        if (lessonRaw) {
          if (!dry_run) await destRedis.set(lessonKey, lessonRaw);
          lessonsTransferred++;
          if (transferLog.length < 8) {
            try {
              const l = JSON.parse(lessonRaw) as { topic: string; outcome: string; what_worked?: string };
              const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
              transferLog.push(`  ${icon} \`${l.topic}\` — ${(l.what_worked ?? '').slice(0, 80)}`);
            } catch { /* skip */ }
          }
        }
      }

      // Record federation provenance
      if (!dry_run) {
        const provEntry = JSON.stringify({
          source, domain, transferred_at: new Date().toISOString(),
          nodes: nodesTransferred, edges: edgesTransferred, lessons: lessonsTransferred,
        });
        await destRedis.rpush('cachly:fedbrain:federations', provEntry);
        await destRedis.ltrim('cachly:fedbrain:federations', -50, -1);
      }

      const dryTag = dry_run ? ' (DRY RUN — no writes)' : '';
      const lines = [
        `🧠 **brain_federate: "${domain}"**${dryTag}`, '',
        `📤 Source: \`${source}\``,
        `📥 Destination: \`${instance_id}\``,
        `🔍 Domain filter: \`${domain}\`  |  min_confidence: ${min_confidence}`,
        '',
        `### Transfer Summary`,
        `  🕸️ CKG nodes:  ${nodesTransferred}`,
        `  🔗 CKG edges:  ${edgesTransferred}  (${skippedLowConf} skipped, confidence < ${min_confidence})`,
        `  📚 Lessons:    ${lessonsTransferred}`,
        '',
      ];
      if (transferLog.length > 0) {
        lines.push(`### Sample lessons transferred:`, ...transferLog);
        if (lessonsTransferred > transferLog.length) lines.push(`  _... and ${lessonsTransferred - transferLog.length} more_`);
        lines.push('');
      }
      if (dry_run) {
        lines.push(`💡 Run without \`dry_run: true\` to apply the transfer.`);
      } else {
        lines.push(`✅ Transfer complete. Your brain now has the \`${domain}\` knowledge from \`${source}\`.`);
        lines.push(`🔍 Explore: \`ckg_inspect(concept="${domain}")\`  |  \`recall_best_solution(topic="${domain}:...")\``);
      }
      return lines.join('\n');
    }

    // ── crystal_view ──────────────────────────────────────────────────────────
    case 'crystal_view': {
      const { instance_id, show_raw = false } = args as { instance_id: string; show_raw?: boolean };
      const redis = await getConnection(instance_id);

      const raw = await redis.get('cachly:crystal:latest');
      if (!raw) {
        return [
          `💎 **Memory Crystal: not yet created**`, '',
          `No crystal found. Create one with \`memory_crystalize()\` to compress your accumulated wisdom.`,
          '', `💡 Tip: run \`memory_crystalize\` monthly for best results.`,
        ].join('\n');
      }

      type Crystal = { label: string; ts: string; session_count: number; lesson_count: number; top_patterns: Array<{ category: string; insight: string; count: number }>; categories: string[]; created_from: string };
      const crystal = safeJsonParse<Crystal | null>(raw, null);
      if (!crystal) return `❌ Memory Crystal data is corrupted. Re-create with \`memory_crystalize()\`.`;
      const age = Math.floor((Date.now() - new Date(crystal.ts).getTime()) / 86400000);
      const freshEmoji = age <= 7 ? '🟢' : age <= 30 ? '🟡' : '🔴';

      const lines = [
        `💎 **Memory Crystal: ${crystal.label}**`, '',
        `📅 Created: ${new Date(crystal.ts).toLocaleDateString('de-DE')} (${age}d ago ${freshEmoji})`,
        `📊 Compressed from: ${crystal.created_from}`,
        `🗂️ Categories: ${crystal.categories.slice(0, 10).map(c => `\`${c}\``).join(', ')}${crystal.categories.length > 10 ? ` +${crystal.categories.length - 10} more` : ''}`,
        '',
        `**🔑 Top patterns (${crystal.top_patterns.length}):**`,
      ];
      for (const p of crystal.top_patterns) {
        lines.push(`  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 110)}`);
      }
      if (age > 30) {
        lines.push('', `⚠️ Crystal is ${age}d old — run \`memory_crystalize()\` to refresh it.`);
      }
      if (show_raw) {
        lines.push('', '```json', JSON.stringify(crystal, null, 2), '```');
      }

      // Team Crystal (W8): the cross-person, causal layer — shown alongside the
      // per-brain crystal when team_crystallize has been run.
      const teamRaw = await redis.get('cachly:crystal:team:latest').catch(() => null);
      if (teamRaw) {
        type TeamPattern = { concept: string; author_count: number; authors: string[]; convergent_fix: string; fix_topic: string; spans: string[] };
        type TeamCrystal = { label: string; ts: string; contributors: number; analysed: number; patterns: TeamPattern[] };
        const tc = safeJsonParse<TeamCrystal | null>(teamRaw, null);
        if (tc && tc.patterns?.length) {
          const tcAge = Math.floor((Date.now() - new Date(tc.ts).getTime()) / 86400000);
          lines.push('', `---`, `💠 **Team Crystal: ${tc.label}** _(${tcAge}d ago · ${tc.contributors} contributors)_`,
            `_Fixes multiple teammates independently converged on — the team-wide layer:_`);
          for (const p of tc.patterns.slice(0, 5)) {
            lines.push(`  • 🧩 **${p.concept}** — ${p.author_count} people (${p.authors.map(a => `@${a}`).join(', ')}): ${p.convergent_fix.slice(0, 90)}`);
          }
        }
      }

      lines.push('', `💡 Refresh: \`memory_crystalize()\` · \`team_crystallize()\`  |  Recover: \`compact_recover(instance_id="...")\``);
      return lines.join('\n');
    }

    // ── compact_recover ───────────────────────────────────────────────────────
    case 'compact_recover': {
      const { instance_id, focus = '' } = args as { instance_id: string; focus?: string };
      const redis = await getConnection(instance_id);

      const lines = [`🔁 **Compact Recovery Briefing**\n`];
      lines.push(`> *Call this first after any context limit hit. Reconstructs where you left off.*\n`);

      // 1. Memory Crystal
      const crystalRaw = await redis.get('cachly:crystal:latest');
      if (crystalRaw) {
        type Crystal = { label: string; ts: string; session_count: number; lesson_count: number; top_patterns: Array<{ category: string; insight: string; count: number }> };
        const crystal = safeJsonParse<Crystal | null>(crystalRaw, null);
        if (crystal) {
          lines.push(`### 💎 Memory Crystal: ${crystal.label}`);
          lines.push(`Compressed from ${crystal.session_count} sessions, ${crystal.lesson_count} lessons.`);
          const topN = focus
            ? crystal.top_patterns.filter(p => p.category.toLowerCase().includes(focus.toLowerCase()) || p.insight.toLowerCase().includes(focus.toLowerCase())).slice(0, 4)
            : crystal.top_patterns.slice(0, 4);
          for (const p of topN) lines.push(`  • **${p.category}**: ${p.insight.slice(0, 100)}`);
          lines.push('');
        }
      }

      // 2. Last session summary
      const lastSession = await redis.get('cachly:session:last');
      if (lastSession) {
        type Session = { summary?: string; ts?: string; focus?: string };
        const sess = safeJsonParse<Session | null>(lastSession, null);
        if (sess) {
          lines.push(`### 🕐 Last Session`);
          if (sess.focus) lines.push(`Focus: _${sess.focus}_`);
          if (sess.summary) lines.push(`Summary: ${sess.summary.slice(0, 300)}`);
          lines.push('');
        }
      }

      // 3. Session handoff
      const handoff = await redis.get('cachly:session:handoff');
      if (handoff) {
        type Handoff = { remaining_tasks?: string[]; instructions?: string; context_summary?: string; blocked_on?: string };
        const h = safeJsonParse<Handoff | null>(handoff, null);
        if (h) {
          lines.push(`### 📋 Handoff (from last window)`);
          if (h.context_summary) lines.push(`Context: ${h.context_summary.slice(0, 200)}`);
          if (h.remaining_tasks?.length) {
            lines.push(`Remaining tasks:`);
            for (const t of h.remaining_tasks.slice(0, 5)) lines.push(`  • ${t}`);
          }
          if (h.instructions) lines.push(`⚠️ Instructions: ${h.instructions.slice(0, 200)}`);
          if (h.blocked_on) lines.push(`🚧 Blocked on: ${h.blocked_on}`);
          lines.push('');
        }
      }

      // 4. WIP registry
      const wipRaw = await redis.get('cachly:ctx:wip-registry');
      if (wipRaw) {
        type Ctx = { content?: string };
        const wip = safeJsonParse<Ctx | null>(wipRaw, null);
        if (wip?.content) {
          lines.push(`### 🔧 WIP Registry`);
          lines.push(wip.content.slice(0, 400));
          lines.push('');
        }
      }

      // 5. Open failures (roadmap with status=blocked/in_progress)
      const roadmapKeys: string[] = [];
      const rStream = redis.scanStream({ match: 'cachly:roadmap:*', count: 100 });
      await new Promise<void>((res, rej) => { rStream.on('data', (b: string[]) => roadmapKeys.push(...b)); rStream.on('end', res); rStream.on('error', rej); });
      const openItems: Array<{ title: string; status: string; priority?: string }> = [];
      for (const k of roadmapKeys.slice(0, 30)) {
        const r = await redis.get(k);
        if (!r) continue;
        try {
          const item = JSON.parse(r) as { title?: string; status?: string; priority?: string };
          if (item.status === 'in_progress' || item.status === 'blocked') openItems.push({ title: item.title ?? k, status: item.status, priority: item.priority });
        } catch { /* skip */ }
      }
      if (openItems.length > 0) {
        lines.push(`### 🚧 Open Items`);
        for (const i of openItems.slice(0, 5)) lines.push(`  • [${i.status}] ${i.title}`);
        lines.push('');
      }

      // 6. Focus-relevant lessons
      if (focus) {
        const lessonKeys: string[] = [];
        const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
        await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });
        const relevant: Array<{ topic: string; what_worked: string }> = [];
        for (const k of lessonKeys) {
          const r = await redis.get(k);
          if (!r) continue;
          try {
            const l = JSON.parse(r) as { topic: string; what_worked?: string };
            if (l.topic.toLowerCase().includes(focus.toLowerCase()) && l.what_worked) {
              relevant.push({ topic: l.topic, what_worked: l.what_worked });
            }
          } catch { /* skip */ }
        }
        if (relevant.length > 0) {
          lines.push(`### 💡 Relevant Lessons for "${focus}"`);
          for (const l of relevant.slice(0, 4)) lines.push(`  • **${l.topic}**: ${l.what_worked.slice(0, 100)}`);
          lines.push('');
        }
      }

      if (lines.length <= 3) {
        lines.push(`_No brain data found. Start accumulating knowledge with \`learn_from_attempts\` and \`session_start\`._`);
      }
      lines.push(`---`, `🧠 Brain is ready. Continue your work — full context restored.`);
      return lines.join('\n');
    }

    // ── brain_from_git ────────────────────────────────────────────────────────
    case 'brain_from_git': {
      const startedAt = Date.now();
      const { instance_id, repo_path = '.', limit = 100, branch = 'HEAD', since = '', incremental = true } = args as {
        instance_id: string; repo_path?: string; limit?: number; branch?: string; since?: string; incremental?: boolean;
      };
      const redis = await getConnection(instance_id);
      const { execSync } = await import('node:child_process');
      const { resolve } = await import('node:path');

      const repoDir = resolve(repo_path);
      const maxCommits = Math.min(Number(limit) || 100, 500);

      // Semaphore: max 10 concurrent git subprocesses per MCP process
      await _gitSemAcquire();
      try {
      // Verify it's a git repo
      try {
        execSync('git rev-parse --git-dir', { cwd: repoDir, stdio: 'pipe' });
      } catch {
        return `❌ Not a git repository: \`${repoDir}\`. Pass \`repo_path\` pointing to a git checkout.`;
      }

      // Incremental mode: resume from last processed commit SHA
      const lastShaKey = `cachly:brain_from_git:last_sha:${Buffer.from(repoDir).toString('base64').slice(0, 32)}`;
      let lastSha = '';
      let isIncremental = false;
      if (incremental !== false && !since) {
        lastSha = (await redis.get(lastShaKey)) ?? '';
        isIncremental = Boolean(lastSha);
      }

      // Build git log command — use --name-only to get changed files per commit
      const sinceFlag = since ? `--since="${since}"` : '';
      const afterFlag = isIncremental ? `${lastSha}..HEAD` : '';
      const revRange = afterFlag || branch;
      const logCmd = `git log ${revRange} ${sinceFlag} --pretty=format:"COMMIT|||%H|||%s|||%ad|||%an" --date=short --no-merges --name-only -n ${maxCommits}`;

      let logOutput = '';
      try {
        logOutput = execSync(logCmd, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' });
      } catch (e) {
        return `❌ git log failed: ${(e as Error).message}. Check \`repo_path\` and \`branch\`.`;
      }

      // Parse multi-line output: each commit block = header line + blank line + file lines
      type CommitEntry = { sha: string; subject: string; date: string; author: string; files: string[] };
      const commits: CommitEntry[] = [];
      let current: CommitEntry | null = null;
      for (const raw of logOutput.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('COMMIT|||')) {
          if (current) commits.push(current);
          const [, sha, subject, date, author] = line.split('|||');
          current = { sha: (sha ?? '').trim(), subject: (subject ?? '').trim(), date: (date ?? '').trim(), author: (author ?? '').trim(), files: [] };
        } else if (line && current) {
          const norm = normalizeGitPath(line);
          if (norm) current.files.push(norm);
        }
      }
      if (current) commits.push(current);

      if (commits.length === 0) {
        if (isIncremental) {
          return `✅ brain_from_git: Brain is up to date — no new commits since last run (last SHA: \`${lastSha.slice(0, 8)}\`).`;
        }
        // Empty repo — first contact must still leave the user with a working path,
        // not a bare warning (roadmap P1-5: onboarding-magic for empty/small repos).
        return buildFirstContactReport({
          repoDir, revRange, processed: 0, ingested: 0, skipped: 0,
          durationMs: Date.now() - startedAt, isIncremental: false,
          instanceId: instance_id, categories: [], suggestedQueries: [],
          emptyReason: `No commits found in \`${repoDir}\` on branch \`${branch}\`${since ? ` since ${since}` : ''}.`,
        });
      }

      // Pattern classifiers
      const classifyCommit = (subject: string): { category: string; outcome: 'success' | 'failure' | 'partial'; severity: 'critical' | 'major' | 'minor' } => {
        const s = subject.toLowerCase();
        if (/\b(fix|fixed|fixes|bug|hotfix|patch|revert|resolve|closes? #\d+)\b/.test(s)) {
          const sev: 'critical' | 'major' | 'minor' = /\b(critical|crash|security|auth|data loss|outage|prod|production)\b/.test(s) ? 'critical' : /\b(major|breaking|regression|hotfix)\b/.test(s) ? 'major' : 'minor';
          return { category: 'fix', outcome: 'success', severity: sev };
        }
        if (/\b(feat|feature|add|added|implement|new|introduce)\b/.test(s)) return { category: 'feat', outcome: 'success', severity: 'minor' };
        if (/\b(refactor|clean|cleanup|improve|simplify|extract|rename)\b/.test(s)) return { category: 'refactor', outcome: 'success', severity: 'minor' };
        if (/\b(perf|optimize|speed|cache|latency|memory|performance)\b/.test(s)) return { category: 'perf', outcome: 'success', severity: 'major' };
        if (/\b(security|cve|auth|csrf|xss|sql|injection|sanitize|escape|encrypt)\b/.test(s)) return { category: 'security', outcome: 'success', severity: 'critical' };
        if (/\b(deploy|ci|cd|build|docker|k8s|helm|infra|devops)\b/.test(s)) return { category: 'deploy', outcome: 'success', severity: 'major' };
        if (/\b(test|spec|coverage|assert|mock|unit|integration)\b/.test(s)) return { category: 'test', outcome: 'success', severity: 'minor' };
        return { category: 'chore', outcome: 'success', severity: 'minor' };
      };

      // Extract domain keywords from commit subject
      const extractDomain = (subject: string): string => {
        const s = subject.toLowerCase();
        const tokens = s.replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/).filter(t => t.length > 3 && !['that', 'this', 'with', 'from', 'when', 'into', 'also', 'some', 'were'].includes(t));
        return tokens.slice(0, 3).join('-') || 'general';
      };

      const ts = new Date().toISOString();
      let ingested = 0;
      let skipped = 0;
      const categoryCount = new Map<string, number>();
      const severityCount = new Map<string, number>();
      const seededTopics: string[] = [];
      // Best commit to use for the proof-of-value recall — prefer a fix (highest signal).
      let proofCandidate: { topic: string; subject: string } | null = null;
      const total = commits.length;
      const progressInterval = Math.max(1, Math.floor(total / 10)); // emit ~10 progress updates
      let lastProgressAt = 0;

      process.stderr.write(`\n🧠 brain_from_git: processing ${total} commits from ${repoDir}...\n`);

      for (let i = 0; i < commits.length; i++) {
        const commit = commits[i]!;

        // Emit progress to stderr so editors can display it in MCP logs
        if (i - lastProgressAt >= progressInterval) {
          process.stderr.write(`   ⏳ Processing ${i}/${total} commits (${ingested} lessons so far)...\n`);
          lastProgressAt = i;
        }

        if (!commit.subject) { skipped++; continue; }
        const { category, outcome, severity } = classifyCommit(commit.subject);
        const domain = extractDomain(commit.subject);
        const topic = `${category}:${domain}`;
        categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);
        severityCount.set(severity, (severityCount.get(severity) ?? 0) + 1);
        seededTopics.push(topic);
        if (!proofCandidate || (category === 'fix' && !proofCandidate.topic.startsWith('fix:'))) {
          proofCandidate = { topic, subject: commit.subject };
        }

        const commitFiles = commit.files.filter(f => f.length > 0).slice(0, 12);
        const lessonObj = {
          topic, outcome, severity,
          what_worked: commit.subject.slice(0, 200),
          what_failed: '',
          context: `git:${commit.sha.slice(0, 8)} by ${commit.author} on ${commit.date}`,
          author: commit.author || undefined,
          file_paths: commitFiles,
          commands: [`git show ${commit.sha.slice(0, 8)}`],
          tags: ['brain_from_git', category, 'git-history'],
          visibility: 'team',
          depends_on: [], recall_count: 0, ts, verified_at: ts,
          confidence: 0.55, // lower confidence for auto-inferred lessons
          audit_trail: [{ ts, action: 'brain_from_git', sha: commit.sha.slice(0, 8) }],
          version: 3,
        };

        // Only store if no existing lesson for this topic (avoid overwriting higher-confidence lessons)
        const existing = await redis.get(`cachly:lesson:best:${topic}`);
        if (!existing) {
          // Auto-inferred git lessons get a 90-day TTL — they self-refresh on the next
          // brain_from_git run, and shouldn't pin memory forever if the repo goes stale.
          await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(lessonObj), 'EX', 90 * 86400);
          await redis.rpush(`cachly:lessons:${topic}`, JSON.stringify(lessonObj));
          await redis.ltrim(`cachly:lessons:${topic}`, -100, -1);
          await redis.expire(`cachly:lessons:${topic}`, 90 * 86400);
        }
        await redis.rpush('cachly:lessons:brain_from_git:all', JSON.stringify({ topic, sha: commit.sha.slice(0, 8), subject: commit.subject.slice(0, 60) }));
        await redis.ltrim('cachly:lessons:brain_from_git:all', -500, -1);
        await redis.expire('cachly:lessons:brain_from_git:all', 90 * 86400);

        // Update CKG — concept node + person node + file nodes
        const conceptId = ckgSlug(topic);
        await ckgUpsertNode(redis, conceptId, category, 'git-derived');

        // Phase 3A: auto-build person + file nodes from git history
        if (commit.author) {
          try {
            const personId = await ckgUpsertPersonNode(redis, commit.author, category);
            await ckgUpdateEdge(redis, personId, 'authored', conceptId, outcome === 'success', outcome === 'partial');
            for (const fp of commitFiles.slice(0, 8)) {
              const fileId = await ckgUpsertFileNode(redis, fp);
              await ckgUpdateEdge(redis, personId, 'touched', fileId, true);
              // Phase 3: build the person↔person collaboration graph from shared files.
              await ckgRecordCollaboration(redis, fileId, personId);
            }
          } catch { /* non-critical */ }
        }

        ingested++;
      }

      process.stderr.write(`   ✅ brain_from_git complete: ${ingested}/${total} commits ingested\n\n`);

      // Save the latest commit SHA for incremental runs
      if (commits.length > 0 && commits[0]?.sha) {
        await redis.set(lastShaKey, commits[0].sha, 'EX', 90 * 24 * 3600); // expire after 90 days
      }

      _lastBrainFromGitCounts = {
        fixes: categoryCount.get('fix') ?? 0,
        features: categoryCount.get('feat') ?? 0,
        refactors: categoryCount.get('refactor') ?? 0,
        total: ingested,
      };

      // ── Proof of value: run ONE real recall against a topic seeded seconds ago,
      // so the first-contact response already demonstrates a working search hit.
      let proof: FirstContactProof | null = null;
      if (proofCandidate && ingested > 0) {
        try {
          const hits = await keywordSearch(redis, ['cachly:lesson:best:*'], proofCandidate.subject, 1);
          if (hits.length > 0) {
            const parsed = safeJsonParse<{ topic?: string; what_worked?: string }>(hits[0]!.content, {});
            proof = {
              query: proofCandidate.subject.slice(0, 80),
              topic: parsed.topic ?? hits[0]!.key.replace('cachly:lesson:best:', ''),
              snippet: (parsed.what_worked ?? '').slice(0, 120) || proofCandidate.subject.slice(0, 120),
            };
          }
        } catch { /* proof is best-effort — never fail the seeding response */ }
      }

      return buildFirstContactReport({
        repoDir, revRange,
        processed: commits.length, ingested, skipped,
        durationMs: Date.now() - startedAt,
        isIncremental, lastSha,
        instanceId: instance_id,
        categories: [...categoryCount.entries()].sort((a, b) => b[1] - a[1]),
        severities: [...severityCount.entries()].sort((a, b) => b[1] - a[1]),
        proof,
        suggestedQueries: suggestRecallQueries(seededTopics, instance_id),
      });
      } finally {
        _gitSemRelease();
      }
    }

    // ── brain_from_ci ─────────────────────────────────────────────────────────
    case 'brain_from_ci': {
      const { instance_id, outcomes } = args as {
        instance_id: string;
        outcomes: Array<{ job: string; status: string; prev_status?: string; context?: string }>;
      };
      const redis = await getConnection(instance_id);
      const ts = Date.now();

      let fixes = 0;
      let breaks = 0;
      let stable = 0;
      const total = outcomes.length;

      for (const entry of outcomes) {
        const status = String(entry.status ?? '');
        const prev_status = String(entry.prev_status ?? '');
        const job = String(entry.job ?? 'unknown');
        const ciCtx = String(entry.context ?? '');

        const isFixed = ['failure', 'red', 'error'].includes(prev_status) && ['success', 'green', 'passed'].includes(status);
        const isBroken = ['success', 'green', 'passed'].includes(prev_status) && ['failure', 'red', 'error'].includes(status);

        const slug = `ci:${ckgSlug(job)}`;
        const conceptId = ckgSlug(slug);
        await ckgUpsertNode(redis, conceptId, 'ci', 'job');

        if (isFixed) {
          const problemId = ckgSlug(`problem:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, problemId, 'problem', 'ci-failure');
          await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, true);
          const lessonObj = {
            topic: slug, outcome: 'success' as const,
            what_worked: `CI job "${job}" went ${prev_status} → ${status}`,
            what_failed: `Job "${job}" was failing`, context: `brain_from_ci: ${ciCtx}`,
            severity: 'major' as const, file_paths: [], commands: [], tags: ['brain_from_ci', 'ci'],
            depends_on: [], recall_count: 0, ts, verified_at: ts, confidence: 0.65,
            audit_trail: [{ ts, action: 'brain_from_ci_fixed' }], version: 3,
          };
          await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
          await redis.ltrim(`cachly:lessons:${slug}`, -100, -1);
          await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));
          fixes++;
        } else if (isBroken) {
          const causeId = ckgSlug(`cause:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, causeId, 'cause', 'ci-break');
          await ckgUpdateEdge(redis, conceptId, 'causes', causeId, false);
          breaks++;
        } else {
          stable++;
        }

        const clsKey = `cachly:cls:${instance_id}`;
        await redis.rpush(clsKey, JSON.stringify({ source: 'ci_outcome', payload: { status, prev_status, job }, ts }));
        await redis.ltrim(clsKey, -200, -1);
      }

      _lastBrainFromCiCounts = { fixes, breaks, stable, total };

      return [
        `📥 **brain_from_ci**: Ingested ${total} outcomes — ${fixes} fixes learned, ${breaks} breaks noted, ${stable} stable`,
        '',
        fixes > 0 ? `✅ ${fixes} fix lesson${fixes !== 1 ? 's' : ''} written (confidence 0.65) — CKG \`fixes\` edges added` : '',
        breaks > 0 ? `🔴 ${breaks} break${breaks !== 1 ? 's' : ''} noted — CKG \`causes\` edges added` : '',
        stable > 0 ? `📊 ${stable} stable outcome${stable !== 1 ? 's' : ''} recorded` : '',
        '',
        `💡 Explore: \`brain_search(query="ci")\`  |  \`brain_predict(context="<job-name>")\``,
      ].filter(Boolean).join('\n');
    }

    // ── brain_predict_failures ─────────────────────────────────────────────────
    case 'brain_predict_failures': {
      const { instance_id, context: ctx, top_k = 5, format = 'detailed' } = args as {
        instance_id: string; context: string; top_k?: number; format?: 'brief' | 'detailed';
      };
      const redis = await getConnection(instance_id);

      const ctxTokens = ctx.toLowerCase().replace(/[^a-z0-9\s\-_:.]/g, ' ').split(/\s+/).filter(t => t.length > 2);

      type FailurePred = { concept: string; failure: string; probability: number; fix?: string; topic?: string; source: 'ckg' | 'lesson' };
      const failures: FailurePred[] = [];

      // Step 1: CKG — find 'causes' and 'degrades_under' edges from context tokens
      for (const token of ctxTokens.slice(0, 8)) {
        const nodeKeys: string[] = [];
        const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 50 });
        await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

        for (const nk of nodeKeys.slice(0, 5)) {
          const nodeRaw = await redis.get(nk);
          if (!nodeRaw) continue;
          const node = safeJsonParse<CKGNode | null>(nodeRaw, null);
          if (!node) continue;
          const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
          for (const ek of edgeKeys.slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge = safeJsonParse<CKGEdge | null>(edgeRaw, null);
            if (!edge) continue;
            if (edge.edgeType !== 'causes' && edge.edgeType !== 'degrades_under') continue;

            // Look up fix for this failure from CKG 'fixes' edges
            const fixEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${edge.to}`);
            let fix: string | undefined;
            for (const fek of fixEdgeKeys.slice(0, 10)) {
              const feRaw = await redis.get(fek);
              if (!feRaw) continue;
              const fe = safeJsonParse<CKGEdge | null>(feRaw, null);
              if (!fe) continue;
              if (fe.edgeType === 'fixes') {
                const lessonRaw = await redis.get(`cachly:lesson:best:${fe.from}`);
                if (lessonRaw) {
                  const lesson = safeJsonParse(lessonRaw, null as null | { what_worked?: string });
                  fix = lesson?.what_worked?.slice(0, 120);
                  break;
                }
              }
            }

            failures.push({
              concept: node.id,
              failure: edge.to.replace(/-/g, ' '),
              probability: edge.confidence,
              fix,
              source: 'ckg',
            });
          }
        }
      }

      // Step 2: Lesson history — find failure-outcome lessons matching context
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 300 });
      await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });

      for (const k of lessonKeys.slice(0, 100)) {
        const r = await redis.get(k);
        if (!r) continue;
        try {
          const l = JSON.parse(r) as { topic: string; outcome: string; what_failed?: string; what_worked?: string; confidence?: number; severity?: string };
          if (l.outcome !== 'failure' && l.outcome !== 'partial') continue;
          if (!l.what_failed) continue;
          const haystack = `${l.topic} ${l.what_failed}`.toLowerCase();
          const matchScore = ctxTokens.filter(t => haystack.includes(t)).length / Math.max(1, ctxTokens.length);
          if (matchScore < 0.15) continue;
          const sevBoost = l.severity === 'critical' ? 0.15 : l.severity === 'major' ? 0.05 : 0;
          failures.push({
            concept: l.topic,
            failure: l.what_failed.slice(0, 80),
            probability: Math.min(0.97, (l.confidence ?? 0.5) * matchScore * 1.5 + sevBoost),
            fix: l.what_worked?.slice(0, 120),
            topic: l.topic,
            source: 'lesson',
          });
        } catch { /* skip */ }
      }

      if (failures.length === 0) {
        return [
          `🔮 **Failure Prediction: "${ctx}"**`, '',
          `No known failure patterns found for this context.`,
          `💡 The brain learns from every \`learn_from_attempts(outcome="failure")\` call.`,
          `🔍 Try: \`brain_predict(context="${ctx}")\` for broader predictions.`,
        ].join('\n');
      }

      // Deduplicate and rank by probability
      const seen = new Set<string>();
      const ranked = failures.filter(f => {
        const k = f.failure.slice(0, 40);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => b.probability - a.probability).slice(0, Number(top_k));

      const lines = [`🔮 **Failure Prediction for: "${ctx}"**\n`];
      lines.push(`> Pre-deploy failure analysis based on ${failures.length} patterns. Ranked by probability.\n`);

      for (let i = 0; i < ranked.length; i++) {
        const f = ranked[i];
        const pct = Math.round(f.probability * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const icon = pct >= 70 ? '🔴' : pct >= 40 ? '🟡' : '🟢';
        lines.push(`${icon} **${i + 1}. ${f.failure}**`);
        lines.push(`   Probability: ${bar} **${pct}%** (${f.source === 'ckg' ? 'CKG causal edge' : 'lesson history'})`);
        if (format === 'detailed' && f.fix) {
          lines.push(`   ✅ Pre-loaded fix: _${f.fix}_`);
        }
        if (format === 'detailed' && f.topic) {
          lines.push(`   📚 Lesson: \`${f.topic}\``);
        }
        lines.push('');
      }

      const highRisk = ranked.filter(f => f.probability >= 0.6);
      if (highRisk.length > 0) {
        lines.push(`⚠️ **${highRisk.length} high-risk failure${highRisk.length > 1 ? 's' : ''} detected** (≥60% probability). Review fixes before proceeding.`);
      } else {
        lines.push(`✅ No high-risk failures detected. Proceed with caution and monitor closely.`);
      }
      lines.push('', `💡 After deploy: \`learn_from_attempts(topic="deploy:...", outcome="success|failure")\` to improve future predictions.`);
      return lines.join('\n');
    }


    // ── Move 5: brain_contribute_signal — privacy-safe federation ────────────
    case 'brain_contribute_signal': {
      const { instance_id, topic_category, outcome, confidence = 0.5 } = args as {
        instance_id: string;
        topic_category: string;
        outcome: string;
        confidence?: number;
      };

      if (!topic_category?.trim()) throw new Error('topic_category is required');
      if (!['success', 'failure', 'partial'].includes(outcome)) {
        throw new Error('outcome must be success, failure, or partial');
      }

      // Bucket locally before sending — no raw confidence value leaves the instance.
      const bucket = confidence >= 0.75 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';

      let apiResult = '📦 Signal stored locally (commons API unavailable)';
      try {
        await apiFetch<{ accepted: boolean; k_threshold: number }>('/api/v1/federation/signals', {
          method: 'POST',
          body: JSON.stringify({
            topic_category: topic_category.trim().toLowerCase(),
            outcome,
            confidence: confidence,
          }),
        });
        apiResult = '✅ Signal contributed to the global commons (no raw data shared)';
      } catch {
        // Store in local outbox for later sync
        const redis = await getConnection(instance_id);
        const outboxKey = `cachly:fed:outbox:${Date.now()}`;
        await redis.set(outboxKey, JSON.stringify({ topic_category, outcome, bucket, ts: new Date().toISOString() }), 'EX', 60 * 60 * 24 * 7).catch(() => {});
      }

      return [
        `🔒 **Brain Contribute Signal: \`${topic_category}\`**`,
        '',
        `📊 Outcome: **${outcome}** · Confidence bucket: **${bucket}**`,
        `🛡️ Privacy: topic category only — no lesson text, no org identity`,
        '',
        apiResult,
        '',
        `💡 When ≥ k orgs contribute the same pattern, a meta-lesson appears in \`brain_import_meta\`.`,
      ].join('\n');
    }

    // ── Move 5: brain_import_meta — import k-anonymous meta-lessons ──────────
    case 'brain_import_meta': {
      const { instance_id, category, limit = 20 } = args as {
        instance_id: string;
        category?: string;
        limit?: number;
      };

      type MetaLessonAPI = {
        topic_category: string;
        dominant_outcome: string;
        avg_confidence: number;
        signal_count: number;
        /** Distinct-Contributor-Zahl (KAI-96); aeltere Server liefern sie nicht. */
        contributor_count?: number;
        derived_at: string;
      };

      let metas: MetaLessonAPI[] = [];
      let kThreshold = 3;
      try {
        const qs = new URLSearchParams();
        if (category) qs.set('category', category);
        qs.set('limit', String(Math.min(limit, 200)));
        const resp = await apiFetch<{ meta_lessons: MetaLessonAPI[]; k_threshold: number }>(
          `/api/v1/federation/meta?${qs.toString()}`
        );
        metas = resp.meta_lessons ?? [];
        kThreshold = resp.k_threshold ?? 3;
      } catch {
        return '❌ Could not reach the global commons API. Try again later.';
      }

      if (metas.length === 0) {
        return [
          `🌐 **Brain Import Meta-Lessons**`,
          '',
          `No meta-lessons available yet (k-threshold: ${kThreshold} signals required).`,
          '',
          `💡 Contribute signals with \`brain_contribute_signal\` to help build the commons.`,
        ].join('\n');
      }

      // Store meta-lessons in local Brain as state:'meta' (never overwrite real lessons).
      const redis = await getConnection(instance_id);
      let imported = 0;
      for (const m of metas) {
        const localKey = `cachly:lesson:best:meta:${m.topic_category}`;
        const existing = await redis.get(localKey);
        if (!existing) {
          await redis.set(localKey, JSON.stringify({
            topic: `meta:${m.topic_category}`,
            outcome: m.dominant_outcome,
            // "independent orgs" only became an honest claim once the API
            // started counting DISTINCT contributors (KAI-96). Older servers
            // omit the field — then say what we actually know: signal rows.
            what_worked: m.contributor_count != null
              ? `Meta-pattern from ${m.contributor_count} independent orgs`
              : `Meta-pattern from ${m.signal_count} signals`,
            what_failed: '',
            recall_count: 0,
            ts: m.derived_at,
            state: 'meta',
            avg_confidence: m.avg_confidence,
            signal_count: m.signal_count,
            audit_trail: [{ ts: new Date().toISOString(), action: 'imported_meta' }],
          }));
          imported++;
        }
      }

      const lines = [
        `🌐 **Brain Import Meta-Lessons** (k ≥ ${kThreshold})`,
        '',
        `| Topic Category | Outcome | Confidence | Signals |`,
        `|---|---|---|---|`,
      ];
      for (const m of metas.slice(0, 15)) {
        const conf = (m.avg_confidence * 100).toFixed(0) + '%';
        lines.push(`| \`${m.topic_category}\` | ${m.dominant_outcome} | ${conf} | ${m.signal_count} |`);
      }
      if (metas.length > 15) lines.push(`| _…${metas.length - 15} more_ | | | |`);
      lines.push('', `✅ **${imported}** new meta-lessons imported into local Brain.`);
      if (imported < metas.length) {
        lines.push(`_(${metas.length - imported} already present — not overwritten)_`);
      }
      return lines.join('\n');
    }

    // ── brain_watch ───────────────────────────────────────────────────────────
    case 'brain_watch': {
      const { instance_id = '', project_dir = '.', api_key } = args as {
        instance_id?: string; project_dir?: string; api_key?: string;
      };
      const { resolve } = await import('node:path');
      const projectDir = resolve(project_dir);

      const { result, hookPath } = await installBrainWatchHook(
        projectDir,
        instance_id,
        api_key as string | undefined,
      );

      if (result === 'skipped-no-git') {
        return [
          `⚠️ **brain_watch: no git repository found**`,
          '',
          `No \`.git\` directory in \`${projectDir}\`.`,
          `Pass \`project_dir\` pointing to a git checkout.`,
        ].join('\n');
      }

      const statusLine: Record<string, string> = {
        written:   '✅ Hook installed (new)',
        upgraded:  '🔄 Hook upgraded to latest version',
        appended:  '📎 Hook appended to existing post-commit script',
        unchanged: '✓ Hook already up to date — nothing changed',
      };

      return [
        `🧠 **brain_watch ${statusLine[result] ?? result}**`,
        '',
        `Hook path: \`${hookPath}\``,
        `Instance:  \`${instance_id || '(none — set CACHLY_BRAIN_INSTANCE_ID or pass instance_id)'}\``,
        '',
        `Every future commit will automatically teach your Brain.`,
        `No manual \`brain_from_git\` needed — the hook runs silently in the background.`,
        '',
        `💡 Verify: \`git commit --allow-empty -m "test brain_watch"\` then \`smart_recall(query="test")\``,
      ].join('\n');
    }

    default:
      return null;
  }
}
