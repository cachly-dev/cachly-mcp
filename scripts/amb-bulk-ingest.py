#!/usr/bin/env python3
"""cachly bulk loader for agent-memory-bench (vendor-supplied, single file).

Contract (agent-memory-bench#61, GiulioDER's adapter):
  reads   AMB_CACHLY_CORPUS_ROOT       corpus directory containing manifest.json
          AMB_CACHLY_CORPUS_MANIFEST   optional explicit manifest path (else root/manifest.json)
          AMB_CACHLY_NAMESPACE         bookkeeping name for the report
          AMB_CACHLY_EXPECTED_SESSIONS optional integer; mismatch is reported, not fatal
          CACHLY_JWT                   credential (handed over privately)
          CACHLY_BRAIN_INSTANCE_ID     the dedicated instance to load
          CACHLY_API_URL               optional API override
  prints  ONE JSON report on stdout; everything else goes to stderr
  exits   0 on success, 2 on refusal (the run must not proceed), 1 on error

Design decisions, learned the hard way on 2026-09-02 and mirrored from the
vendor's own pre-registered private runs so both measurements share semantics:

* Writes go through the PRODUCT's pinned MCP server (npx, stdio) — the write
  path under test, not a reimplementation. Loader pin: 0.10.152 (first release
  whose read-side healing cannot lose write-ahead markers).
* FRESH INSTANCE REQUIRED. Re-learning an existing topic without a `grund`
  field is rejected by the product (by design) while looking like success to a
  bulk caller. The loader therefore refuses to load into a non-empty instance
  instead of producing a silently half-blind store.
* Chunking identical to the vendor adapter: verbatim transcript pieces of
  <= 1600 chars, "role: content" lines, session date appended as
  "[session of YYYY-MM-DD]"; topics amb:<path-slug>:<n>.
* Acceptance is part of the load: semantic coverage (brain_doctor) must reach
  95%, with read-path healing driven until the bar is met or progress stops.
  A stalled store is a REFUSAL, never a quiet degradation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

LOADER_VERSION = "1.1.0"
PACKAGE_PIN = "@cachly-dev/mcp-server@0.10.153"
CHUNK_CHARS = 1600
MCP_TIMEOUT_S = 120
MIN_COVERAGE = 0.95
INGEST_DELAY_MS = int(os.environ.get("AMB_CACHLY_INGEST_DELAY_MS", "150"))


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class McpStdio:
    """Minimal JSON-RPC-over-stdio client for one pinned MCP server process."""

    def __init__(self, env: dict) -> None:
        resolved = shutil.which("npx") or "npx"
        neutral = tempfile.mkdtemp(prefix="cachly-bulk-cwd-")
        self.proc = subprocess.Popen(
            [resolved, "-y", PACKAGE_PIN],
            cwd=neutral,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.next_id = 0

    def call(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        req = {"jsonrpc": "2.0", "id": self.next_id, "method": method}
        if params is not None:
            req["params"] = params
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + MCP_TIMEOUT_S
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError(f"MCP server silent for {method} within {MCP_TIMEOUT_S}s")
            line = self.proc.stdout.readline()
            if line == "":
                err = self.proc.stderr.read() if self.proc.stderr else ""
                raise RuntimeError(f"MCP server exited during {method}: {err[-400:]}")
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == self.next_id:
                if "error" in msg:
                    raise RuntimeError(f"{method} -> {msg['error']}")
                return msg.get("result", {})

    def handshake(self) -> None:
        self.call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "amb-bulk-ingest", "version": LOADER_VERSION},
        })
        try:
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass

    def close(self) -> None:
        try:
            self.proc.terminate()
        except Exception:
            pass


def with_patience(fn, what: str):
    """Throttle/provisioning wording retries with backoff; real errors fail on try one."""
    for attempt in range(6):
        try:
            return fn()
        except (RuntimeError, TimeoutError) as err:
            wording = str(err).lower()
            transient = ("429" in wording or "too many" in wording or "rate" in wording
                         or "404" in wording or "provisioning" in wording)
            if not transient or attempt == 5:
                raise
            wait = min(60, 2 ** (attempt + 1))
            log(f"[patience] {what}: transient ({wording[:80]}), retry in {wait}s")
            time.sleep(wait)


def slug(rel_path: str) -> str:
    out = "".join(ch if ch.isalnum() else "-" for ch in rel_path.lower()).strip("-")
    while "--" in out:
        out = out.replace("--", "-")
    return out


def session_chunks(rows: list) -> tuple:
    datum = ""
    for row in rows:
        ts = str(row.get("ts", ""))
        if ts:
            datum = ts[:10]
            break
    pieces, akt, laenge = [], [], 0
    for row in rows:
        content = str(row.get("content", "")).strip()
        if not content:
            continue
        zeile = f"{row.get('role', '?')}: {content}"
        if laenge + len(zeile) > CHUNK_CHARS and akt:
            pieces.append("\n".join(akt))
            akt, laenge = [], 0
        akt.append(zeile)
        laenge += len(zeile) + 1
    if akt:
        pieces.append("\n".join(akt))
    return datum, pieces


def doctor_coverage(client: McpStdio, instance_id: str) -> int:
    antwort = with_patience(
        lambda: client.call("tools/call", {"name": "brain_doctor", "arguments": {"instance_id": instance_id}}),
        "brain_doctor",
    )
    text = json.dumps(antwort)
    m = re.search(r"Semantic coverage[^0-9]*(\d+)%", text)
    if m:
        return int(m.group(1))
    if "semantic search is OFF" in text:
        return 0
    raise RuntimeError("brain_doctor reported no coverage line; refusing to pass silently")


def doctor_lessons(client: McpStdio, instance_id: str) -> int:
    """Lesson count from brain_doctor's STATE line — never from tip prose.

    A greedy '(\\d+) lessons' also matches the tool's own tip text
    ("bootstrap with 16 universal lessons") and once refused a genuinely
    empty instance. Only the explicit state line counts.
    """
    antwort = with_patience(
        lambda: client.call("tools/call", {"name": "brain_doctor", "arguments": {"instance_id": instance_id}}),
        "brain_doctor",
    )
    text = json.dumps(antwort)
    m = re.search(r"Lessons:\*{0,2}\s*(\d+)", text)
    return int(m.group(1)) if m else 0


def heal_to_coverage(client: McpStdio, instance_id: str) -> int:
    """Drive read-side healing (smart_recall pops write-ahead markers) to the bar."""
    best = doctor_coverage(client, instance_id)
    stagnant = 0
    for runde in range(60):
        if best >= int(MIN_COVERAGE * 100):
            return best
        for i in range(10):
            try:
                client.call("tools/call", {"name": "smart_recall", "arguments": {
                    "instance_id": instance_id, "query": f"healing sweep {runde}-{i}"}})
            except Exception:
                pass
            time.sleep(2)
        now = doctor_coverage(client, instance_id)
        log(f"[heal] round {runde + 1}: coverage {now}%")
        stagnant = stagnant + 1 if now <= best else 0
        best = max(best, now)
        if stagnant >= 3:
            break
    return best


def main() -> int:
    root = os.environ.get("AMB_CACHLY_CORPUS_ROOT", "")
    manifest_path = os.environ.get("AMB_CACHLY_CORPUS_MANIFEST") or os.path.join(root, "manifest.json")
    namespace = os.environ.get("AMB_CACHLY_NAMESPACE", "")
    expected = os.environ.get("AMB_CACHLY_EXPECTED_SESSIONS")
    instance_id = os.environ.get("CACHLY_BRAIN_INSTANCE_ID", "")
    jwt = os.environ.get("CACHLY_JWT", "")

    def report(payload: dict, code: int) -> int:
        payload.setdefault("product", "cachly")
        payload.setdefault("loader_version", LOADER_VERSION)
        payload.setdefault("package_pin", PACKAGE_PIN)
        payload.setdefault("namespace", namespace)
        payload.setdefault("instance_id", instance_id)
        print(json.dumps(payload), flush=True)
        return code

    if not root or not os.path.isdir(root):
        return report({"refused": True, "reason": f"AMB_CACHLY_CORPUS_ROOT missing or not a directory: {root!r}"}, 2)
    if not os.path.isfile(manifest_path):
        return report({"refused": True, "reason": f"manifest not found: {manifest_path}"}, 2)
    if not instance_id or not jwt:
        return report({"refused": True, "reason": "CACHLY_BRAIN_INSTANCE_ID and CACHLY_JWT are required"}, 2)

    manifest = json.loads(open(manifest_path, encoding="utf-8").read())
    sessions = dict(manifest.get("sessions", {}))
    if expected is not None and str(len(sessions)) != str(expected):
        log(f"[warn] manifest lists {len(sessions)} sessions, AMB_CACHLY_EXPECTED_SESSIONS={expected}")

    # Manifest integrity: same bytes for every adapter, verified before a single write.
    for rel, want in sessions.items():
        if os.path.isabs(rel) or ".." in rel.replace("\\", "/").split("/"):
            return report({"refused": True, "reason": f"manifest path escapes root: {rel}"}, 2)
        p = os.path.join(root, rel)
        if not os.path.isfile(p):
            return report({"refused": True, "reason": f"manifest names missing file: {rel}"}, 2)
        got = hashlib.sha256(open(p, "rb").read()).hexdigest()
        if got != want:
            return report({"refused": True, "reason": f"sha256 mismatch for {rel}"}, 2)

    env = dict(os.environ)
    env["CACHLY_JWT"] = jwt
    env["CACHLY_BRAIN_INSTANCE_ID"] = instance_id
    if os.environ.get("CACHLY_API_URL"):
        env["CACHLY_API_URL"] = os.environ["CACHLY_API_URL"]

    start = time.monotonic()
    client = McpStdio(env)
    try:
        with_patience(client.handshake, "handshake")

        # Freshness gate. Measured product behavior (2026-09-02): a virgin free
        # instance receives 16 curated starter lessons around its first tool
        # contact — product-as-shipped, not prior usage. Those are tolerated
        # and DISCLOSED (baseline_lessons in the report); anything beyond 16
        # means the instance was actually used, and re-learning an existing
        # topic without a 'grund' field is rejected by the product while
        # looking like success to a bulk caller.
        AUTO_SEED_MAX = 16
        baseline = doctor_lessons(client, instance_id)
        if baseline > AUTO_SEED_MAX:
            return report({
                "refused": True,
                "reason": (
                    f"instance already holds {baseline} lessons (more than the product's "
                    f"{AUTO_SEED_MAX}-lesson auto-seed) — it has been used. Load into a "
                    f"FRESH instance instead."
                ),
                "baseline_lessons": baseline,
            }, 2)
        if baseline:
            log(f"[baseline] {baseline} product starter lessons present; reported, tolerated")
            # The original auto-seed wrote lessons WITHOUT vectors or healing
            # markers (measured 2026-09-02: they capped a fresh instance's
            # coverage at 16%). Re-seeding with force refreshes the same 16
            # lessons THROUGH the fixed path (>= 0.10.153), which plants
            # write-ahead markers — the read-side healer then embeds them like
            # any other lesson, and the 95% acceptance covers the whole store.
            with_patience(
                lambda: client.call("tools/call", {"name": "brain_seed_starter", "arguments": {
                    "instance_id": instance_id, "force": True}}),
                "brain_seed_starter(force)",
            )

        stored = 0
        for rel in sorted(sessions):
            rows = []
            for line in open(os.path.join(root, rel), encoding="utf-8").read().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            datum, chunks = session_chunks(rows)
            s = slug(rel)
            for i, chunk in enumerate(chunks):
                text = chunk if not datum else f"{chunk}\n[session of {datum}]"
                args = {"name": "learn_from_attempts", "arguments": {
                    "instance_id": instance_id,
                    "topic": f"amb:{s}:{i + 1}",
                    "outcome": "success",
                    "what_worked": text[:1800],
                    "severity": "minor",
                    "tags": ["amb"],
                    "file_paths": [rel],
                }}
                with_patience(lambda a=args: client.call("tools/call", a), f"learn {s}:{i + 1}")
                stored += 1
                if stored % 100 == 0:
                    log(f"[ingest] {stored} items stored")
                time.sleep(INGEST_DELAY_MS / 1000.0)

        coverage = heal_to_coverage(client, instance_id)
        duration = round(time.monotonic() - start, 1)
        if coverage / 100.0 < MIN_COVERAGE:
            return report({
                "refused": True,
                "reason": (
                    f"semantic coverage stalled at {coverage}% (minimum {MIN_COVERAGE:.0%}) despite "
                    f"read-path healing. The memory cannot see; running sessions against it would "
                    f"measure a wiring fault, not the product."
                ),
                "items_stored": stored,
                "coverage_percent": coverage,
                "duration_seconds": duration,
            }, 2)

        return report({
            "refused": False,
            "sessions": len(sessions),
            "items_stored": stored,
            "baseline_lessons": baseline,
            "coverage_percent": coverage,
            "duration_seconds": duration,
            "notes": [
                "embeddings computed server-side (bge-m3 + second witness); no local model ran",
                "chunking: verbatim <=1600-char transcript pieces, session date appended in content",
            ],
        }, 0)
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
