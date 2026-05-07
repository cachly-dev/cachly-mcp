// Safely parses a JSON string. Returns `fallback` on null, empty, or malformed
// input instead of throwing a SyntaxError that would fail the entire tool call.
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
