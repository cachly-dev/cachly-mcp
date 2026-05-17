/**
 * Offline mutation queue — persists pending creates/updates in SQLite.
 * Drains automatically when network returns.
 *
 * Pattern: same as cachly's "never lose a write" approach — buffer locally,
 * replay in order when the API is reachable again.
 */
import * as SQLite from "expo-sqlite";
import * as Network from "expo-network";
import { ApiError } from "./api";

const db = SQLite.openDatabaseSync("tco.db");

export type QueuedOp = {
  id: number;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body: string | null;
  created_at: number;
  retries: number;
};

export function initQueue(): void {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS offline_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      method     TEXT NOT NULL,
      path       TEXT NOT NULL,
      body       TEXT,
      created_at INTEGER NOT NULL,
      retries    INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function enqueue(method: QueuedOp["method"], path: string, body?: object): void {
  db.runSync(
    "INSERT INTO offline_queue (method, path, body, created_at) VALUES (?, ?, ?, ?)",
    [method, path, body ? JSON.stringify(body) : null, Date.now()]
  );
}

export function getPending(): QueuedOp[] {
  return db.getAllSync<QueuedOp>("SELECT * FROM offline_queue ORDER BY id ASC");
}

export function dequeue(id: number): void {
  db.runSync("DELETE FROM offline_queue WHERE id = ?", [id]);
}

export function incrementRetry(id: number): void {
  db.runSync("UPDATE offline_queue SET retries = retries + 1 WHERE id = ?", [id]);
}

// Ops that have failed > 5 times are discarded — avoids infinite poison-pill loops
export function purgeFailed(maxRetries = 5): void {
  db.runSync("DELETE FROM offline_queue WHERE retries >= ?", [maxRetries]);
}

export let onQueueError: ((count: number) => void) | null = null;

export function setQueueErrorCallback(cb: (count: number) => void): void {
  onQueueError = cb;
}

/** Alias used by api.ts — enqueue a failed mutation for later replay. */
export function enqueueRequest(method: QueuedOp["method"], path: string, body?: object): void {
  enqueue(method, path, body);
}

/** Alias used by useNetworkSync — drain the queue using stored auth. */
export async function processQueue(
  authHeaders: () => Promise<Record<string, string>>,
  baseUrl: string
): Promise<{ succeeded: number; failed: number }> {
  return drainQueue(authHeaders, baseUrl);
}

export async function drainQueue(
  authHeaders: () => Promise<Record<string, string>>,
  baseUrl: string
): Promise<{ succeeded: number; failed: number }> {
  const net = await Network.getNetworkStateAsync();
  if (!net.isConnected) return { succeeded: 0, failed: 0 };

  purgeFailed();
  const ops = getPending();
  let succeeded = 0;
  let failed = 0;

  const headers = await authHeaders();
  let permanentlyRemoved = 0;

  for (const op of ops) {
    try {
      const res = await fetch(`${baseUrl}${op.path}`, {
        method: op.method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: op.body ?? undefined,
      });
      if (res.ok || res.status === 404) {
        dequeue(op.id);
        succeeded++;
      } else if (res.status === 429) {
        incrementRetry(op.id);
        failed++;
      } else if (res.status >= 400 && res.status < 500) {
        dequeue(op.id);
        permanentlyRemoved++;
        failed++;
      } else {
        incrementRetry(op.id);
        failed++;
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 || err.status === 403) {
          console.warn(`offlineQueue: removing unrecoverable op ${op.id} (${err.status})`);
          dequeue(op.id);
          permanentlyRemoved++;
          failed++;
        } else if (err.status === 429 || err.status == null) {
          incrementRetry(op.id);
          failed++;
        } else if (err.status >= 400 && err.status < 500) {
          dequeue(op.id);
          permanentlyRemoved++;
          failed++;
        } else {
          incrementRetry(op.id);
          failed++;
        }
      } else {
        incrementRetry(op.id);
        failed++;
      }
    }
  }

  if (permanentlyRemoved > 0) {
    onQueueError?.(permanentlyRemoved);
  }

  return { succeeded, failed };
}
