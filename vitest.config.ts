import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // E2E tests require live credentials + network (run via npm run test:e2e).
    // Exclude them from the default unit-test suite so CI publish is not blocked.
    exclude: [
      '**/__tests__/e2e/**',
      '**/node_modules/**',
      // Compiled dist/ files are identical to src/ — run tests only from source
      '**/dist/**',
    ],
    // Flake-Klasse E fix: Increase testTimeout to prevent flakes under parallel load.
    // Empirical evidence: timeouts in brain-flow.test.ts, onboarding-bench.test.ts,
    // and corpus-sample-test under concurrent web build. See .agent/cachly/tasks/SDK-004.md
    testTimeout: 20000,
    hookTimeout: 20000,
    isolate: true,
    poolOptions: {
      threads: {
        maxWorkers: 1,
        singleThread: false,
        isolateWorkerModules: true,
      },
    },
  },
});
