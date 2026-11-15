// Stub MCP server (stdio) for amb-bulk-ingest.contract.test.ts. No network.
// Appends one JSON line per event to AMB_FAKE_LOG. Never records credential VALUES,
// only which credential variables were present.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (o) =>
  appendFileSync(process.env.AMB_FAKE_LOG, JSON.stringify(o) + "\n");
log({
  ev: "start",
  has_jwt: !!process.env.CACHLY_JWT,
  has_api_key: !!process.env.CACHLY_API_KEY,
  instance: process.env.CACHLY_BRAIN_INSTANCE_ID,
});
const lessons = Number(process.env.AMB_FAKE_LESSONS ?? "0");
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "tools/call") {
    const { name, arguments: a } = m.params;
    if (name === "learn_from_attempts") log({ ev: "learn", topic: a.topic });
    if (name === "brain_doctor") {
      return reply(m.id, {
        content: [
          {
            type: "text",
            text: `**Lessons:** ${lessons}\nSemantic coverage: 100%`,
          },
        ],
      });
    }
  }
  reply(m.id, { content: [{ type: "text", text: "ok" }] });
});
