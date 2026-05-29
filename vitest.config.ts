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
  },
});
