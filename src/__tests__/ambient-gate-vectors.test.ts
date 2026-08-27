/**
 * Golden-vector tests for the Ambient Recall relevance gate (Phase 4, §6.3/§6.6),
 * following the confidence-vectors.json (P0-21) methodology.
 *
 * The vectors in docs/spec/ambient-gate-vectors.json pin three things:
 *   1. the trivial-skip classifier (isTrivialPrompt) on labeled prompts, plus
 *      aggregate skip precision/recall thresholds — skip precision is a HARD 1.0:
 *      a skipped prompt must never be a real engineering request;
 *   2. exact selectInjectable decisions (floors, ordering, topK, budget break);
 *   3. calibration scenarios with ground-truth relevant_ids, from which the suite
 *      computes aggregate injection precision/recall against the spec thresholds.
 *      Deliberate conservative trade-offs (a relevant lesson at score 0.70 stays
 *      out; borderline 0.73 noise slips in) are encoded in the scenarios.
 *
 * Unlike confidence-vectors.test.ts there is only ONE implementation (this
 * package), so no cross-language transpilation is needed — but the spec file
 * still lives in the monorepo's docs/spec/, so the suite skips when the package
 * is built standalone (the published npm mirror).
 *
 * Run: npx vitest run src/__tests__/ambient-gate-vectors.test.ts
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { IM_MONOREPO } from './im-monorepo.js';

import {
  isTrivialPrompt,
  selectInjectable,
  DEFAULT_GATE,
  type LessonCandidate,
  type GateOptions,
} from '../ambient-recall.js';

// ── Vector schema (mirrors docs/spec/ambient-gate-vectors.json) ───────────────

interface TrivialVector {
  prompt: string;
  label: 'trivial' | 'substantive';
}

interface GateVector {
  description: string;
  prompt: string;
  candidates: LessonCandidate[];
  opts?: Partial<GateOptions>;
  expected: { inject: boolean; reason: string; selected_ids: string[]; tokens: number };
}

interface CalibScenario {
  description: string;
  prompt: string;
  candidates: LessonCandidate[];
  relevant_ids: string[];
}

interface VectorFile {
  source_of_truth: string;
  default_gate: GateOptions;
  thresholds: {
    skip_precision_min: number;
    skip_recall_min: number;
    injection_precision_min: number;
    injection_recall_min: number;
  };
  trivial_vectors: TrivialVector[];
  gate_vectors: GateVector[];
  calibration_scenarios: CalibScenario[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const VECTORS_PATH = path.join(REPO_ROOT, 'docs/spec/ambient-gate-vectors.json');

// Monorepo-only: the shared spec lives outside this package. When sdk/mcp is
// published standalone to npm the file doesn't exist — skip instead of failing.
//
// Die Entscheidung kommt aus im-monorepo.ts (Karte nbks8m1ty4d7). Vorher hing
// sie an der Existenz der Vektor-Datei — ein Umzug haette die Suite still
// verschwinden lassen, statt sie rot zu machen.
const monorepo = IM_MONOREPO;
const d = monorepo ? describe : describe.skip;

const spec: VectorFile | null = monorepo ? (JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as VectorFile) : null;

d('ambient gate golden vectors (docs/spec/ambient-gate-vectors.json)', () => {
  it('pins DEFAULT_GATE to the spec', () => {
    expect(DEFAULT_GATE).toEqual(spec!.default_gate);
  });

  it('classifies every labeled prompt correctly (trivial-skip)', () => {
    for (const v of spec!.trivial_vectors) {
      const got = isTrivialPrompt(v.prompt) ? 'trivial' : 'substantive';
      expect(got, `prompt: "${v.prompt}"`).toBe(v.label);
    }
  });

  it('meets the skip precision/recall thresholds', () => {
    let skipped = 0;
    let skippedTrivial = 0;
    let trivial = 0;
    for (const v of spec!.trivial_vectors) {
      const isSkipped = isTrivialPrompt(v.prompt);
      if (v.label === 'trivial') trivial++;
      if (isSkipped) {
        skipped++;
        if (v.label === 'trivial') skippedTrivial++;
      }
    }
    const precision = skipped ? skippedTrivial / skipped : 1;
    const recall = trivial ? skippedTrivial / trivial : 1;
    expect(precision, 'skip precision (a skipped prompt must never be a real request)').toBeGreaterThanOrEqual(
      spec!.thresholds.skip_precision_min,
    );
    expect(recall, 'skip recall (greetings must be skipped)').toBeGreaterThanOrEqual(spec!.thresholds.skip_recall_min);
  });

  it.each((spec?.gate_vectors ?? []).map((v) => [v.description, v] as const))('%s', (_desc, v) => {
    const decision = selectInjectable(v.prompt, v.candidates, v.opts ?? {});
    expect(decision.inject).toBe(v.expected.inject);
    expect(decision.reason).toBe(v.expected.reason);
    expect(decision.selected.map((c) => c.id)).toEqual(v.expected.selected_ids);
    expect(decision.tokens).toBe(v.expected.tokens);
  });

  it('meets the injection precision/recall thresholds across calibration scenarios', () => {
    let selectedTotal = 0;
    let hitTotal = 0;
    let relevantTotal = 0;
    for (const s of spec!.calibration_scenarios) {
      const decision = selectInjectable(s.prompt, s.candidates);
      const ids = new Set(decision.selected.map((c) => c.id));
      selectedTotal += ids.size;
      relevantTotal += s.relevant_ids.length;
      hitTotal += s.relevant_ids.filter((id) => ids.has(id)).length;
    }
    const precision = selectedTotal ? hitTotal / selectedTotal : 1;
    const recall = relevantTotal ? hitTotal / relevantTotal : 1;
    expect(precision, 'injection precision').toBeGreaterThanOrEqual(spec!.thresholds.injection_precision_min);
    expect(recall, 'injection recall').toBeGreaterThanOrEqual(spec!.thresholds.injection_recall_min);
  });
});
