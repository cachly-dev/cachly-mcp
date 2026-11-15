// End-to-end contract test: runs the REAL scripts/amb-bulk-ingest.py as a subprocess
// (stub MCP server instead of npx, no network) and parses stdout exactly like the
// maintainer's adapter (agent-memory-bench adapters/cachly/adapter.py: ingest,
// _last_json_object, _positive_int).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const LOADER = fileURLToPath(
  new URL("../../scripts/amb-bulk-ingest.py", import.meta.url),
);
const STUB = fileURLToPath(
  new URL("./fixtures/amb-fake-mcp.mjs", import.meta.url),
);

function findPython(): string | undefined {
  for (const c of ["python3", "python"]) {
    const r = spawnSync(
      c,
      ["-c", "import sys; assert sys.version_info >= (3, 8)"],
      { encoding: "utf8" },
    );
    if (r.status === 0) return c;
  }
  return undefined;
}
const PYTHON = findPython();
// In CI a missing Python must fail loudly: a skipped contract test would read as green.
if (!PYTHON && process.env.CI) {
  throw new Error(
    "[amb-bulk-ingest.contract] no python3/python on the CI runner; the contract test cannot run",
  );
}
if (!PYTHON)
  console.warn("[amb-bulk-ingest.contract] SKIPPED: no python3/python on PATH");

// Faithful ports of the adapter's helpers.
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* next line */
    }
  }
  return null;
}
function positiveInt(report: Record<string, unknown>, key: string): number {
  const v = report[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`no positive integer ${key}: ${JSON.stringify(report)}`);
  }
  return v;
}

const dirs: string[] = [];
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

function makeCorpus(): { root: string; sessions: number; work: string } {
  const work = mkdtempSync(join(tmpdir(), "amb-contract-"));
  dirs.push(work);
  const root = join(work, "corpus");
  mkdirSync(join(root, "sessions", "task"), { recursive: true });
  const sessions: Record<string, string> = {};
  for (const n of [1, 2, 3]) {
    const rel = `sessions/task/p0${n}.jsonl`;
    const body =
      [
        { ts: `2026-01-0${n}T10:00:00Z`, role: "user", content: `Frage ${n}` },
        {
          ts: `2026-01-0${n}T10:00:05Z`,
          role: "assistant",
          content: `Antwort ${n}`,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n";
    writeFileSync(join(root, rel), body);
    sessions[rel] = createHash("sha256").update(body).digest("hex");
  }
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ sessions }));
  return { root, sessions: 3, work };
}

function runLoader(
  creds: Record<string, string>,
  opts: { lessons?: number } = {},
) {
  const c = makeCorpus();
  const log = join(c.work, "fake.log");
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["CACHLY_JWT", "CACHLY_API_KEY"]) delete env[k];
  Object.assign(env, creds, {
    AMB_CACHLY_CORPUS_ROOT: c.root,
    AMB_CACHLY_CORPUS_MANIFEST: join(c.root, "manifest.json"),
    AMB_CACHLY_NAMESPACE: "ns-test",
    AMB_CACHLY_EXPECTED_SESSIONS: String(c.sessions),
    AMB_CACHLY_INGEST_DELAY_MS: "0",
    AMB_CACHLY_MCP_COMMAND: JSON.stringify([process.execPath, STUB]),
    AMB_FAKE_LOG: log,
    AMB_FAKE_LESSONS: String(opts.lessons ?? 0),
    CACHLY_BRAIN_INSTANCE_ID: "instance-for-tests",
    PYTHONUTF8: "1",
  });
  const r = spawnSync(PYTHON!, [LOADER], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  const events = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { r, events, sessions: c.sessions };
}

describe.skipIf(!PYTHON)(
  "amb-bulk-ingest.py honours the adapter contract",
  () => {
    function expectAdapterAccepts(r: { stdout: string }, sessions: number) {
      const report = lastJsonObject(r.stdout);
      expect(report).not.toBeNull();
      expect(positiveInt(report!, "sessions_offered")).toBe(sessions);
      expect(positiveInt(report!, "items_stored")).toBeGreaterThan(0);
      expect(report!.namespace).toBe("ns-test");
      return report!;
    }

    it("CACHLY_API_KEY only: exit 0, adapter-conform report, key reaches the server", () => {
      const { r, events, sessions } = runLoader({
        CACHLY_API_KEY: "cky_live_secret-for-test",
      });
      expect(r.status, r.stderr).toBe(0);
      const report = expectAdapterAccepts(r, sessions);
      expect(report.sessions).toBe(3); // alias kept
      expect(report.items_stored).toBe(
        events.filter((e) => e.ev === "learn").length,
      );
      expect(events[0]).toMatchObject({
        ev: "start",
        has_api_key: true,
        has_jwt: false,
      });
      expect(r.stdout + r.stderr).not.toContain("cky_live_secret-for-test");
    });

    it("CACHLY_JWT only: exit 0, adapter-conform report", () => {
      const { r, events, sessions } = runLoader({
        CACHLY_JWT: "jwt-secret-for-test",
      });
      expect(r.status, r.stderr).toBe(0);
      expectAdapterAccepts(r, sessions);
      expect(events[0]).toMatchObject({
        ev: "start",
        has_api_key: false,
        has_jwt: true,
      });
      expect(r.stdout + r.stderr).not.toContain("jwt-secret-for-test");
    });

    it("no credential: refusal with exit 2 and JSON, server never started", () => {
      const { r, events } = runLoader({});
      expect(r.status).toBe(2);
      const report = lastJsonObject(r.stdout);
      expect(report).toMatchObject({ refused: true, namespace: "ns-test" });
      expect(String(report!.reason)).toMatch(/CACHLY_API_KEY|CACHLY_JWT/);
      expect(events).toHaveLength(0);
    });

    it("used instance (more than 16 lessons): refusal exit 2, nothing written", () => {
      const { r, events } = runLoader({ CACHLY_API_KEY: "k" }, { lessons: 40 });
      expect(r.status).toBe(2);
      const report = lastJsonObject(r.stdout);
      expect(report).toMatchObject({ refused: true, baseline_lessons: 40 });
      expect(events.filter((e) => e.ev === "learn")).toHaveLength(0);
    });
  },
);
