import { defineConfig } from 'vitest/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Netzsperre: Tests duerfen nie nach aussen (12.10.2026) ────────────────────
//
// Ein von Hand gestarteter Hook-Lauf ohne CACHLY_API_URL meldete rund 50 Mal an
// die PRODUKTIONS-API; fail2ban sperrte die eigene IP fuer 6 Stunden. Seither
// gilt fuer jeden Testlauf (Details: scripts/kein-netz-vorlauf.cjs):
//   1. Jede TCP-Verbindung zu einem Ziel ausserhalb dieses Rechners scheitert
//      und wird gezaehlt, im Testprozess UND (ueber NODE_OPTIONS) in jedem
//      Kindprozess, den ein Test startet. Loopback (Attrappen-Server) bleibt offen.
//   2. Ein Test, der es versucht, wird rot, auch wenn der Produktcode den
//      Fehler schluckt; am Ende des Laufs steht die Summe im Protokoll.
//   3. Die Update-Abfrage bei npm ist aus (CACHLY_UPDATE_CHECK=false): sie ist
//      Netz im Hintergrund und wuerde sonst dem Test zugeschrieben, der gerade laeuft.
// CACHLY_API_URL wird bewusst NICHT umgebogen: ein paar Tests pruefen den
// Standardwert (https://api.cachly.dev), und die Sperre haelt jede Adresse auf.
// Ausnahme: scripts/e2e-run.sh setzt CACHLY_NETZSPERRE=aus (echte Live-Tests).
if (process.env.CACHLY_NETZSPERRE !== 'aus') {
  const vorlauf = fileURLToPath(new URL('./scripts/kein-netz-vorlauf.cjs', import.meta.url)).replaceAll('\\', '/');
  process.env.CACHLY_NETZSPERRE_LOG ??= join(tmpdir(), `cachly-netzsperre-${process.pid}.log`);
  process.env.CACHLY_UPDATE_CHECK = 'false';
  if (!(process.env.NODE_OPTIONS ?? '').includes(vorlauf)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require "${vorlauf}"`.trim();
  }
}

export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/kein-netz.setup.ts'],
    globalSetup: ['./src/__tests__/kein-netz.global.ts'],
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
