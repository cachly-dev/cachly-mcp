import { getAccessToken } from "./auth";
import { enqueueRequest } from "./offlineQueue";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL!;

/** Default timeout for regular API calls (trips, items, users, etc.) */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Extended timeout for AI parse calls (Ollama can be slow on first run) */
const PARSE_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const headers = await authHeaders();
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(`API ${res.status}: ${body}`, res.status, body);
    }
    return res.json() as Promise<T>;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError("Timeout: Server antwortet nicht", 408, "timeout");
    }
    // Network error (no status) — queue for offline retry
    if (!(err instanceof ApiError) && init.method && ["POST","PATCH","DELETE"].includes(init.method)) {
      enqueueRequest(init.method as "POST" | "PATCH" | "DELETE", path, init.body as string | undefined);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── Trips ──────────────────────────────────────────────────────────────────

export type Trip = {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
};

export const tripsApi = {
  list: () => request<Trip[]>("/api/v1/trips"),
  get: (id: string) => request<Trip>(`/api/v1/trips/${id}`),
  create: (data: Pick<Trip, "name" | "description" | "start_date" | "end_date">) =>
    request<Trip>("/api/v1/trips", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Trip>) =>
    request<Trip>(`/api/v1/trips/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  delete: (id: string) => request<void>(`/api/v1/trips/${id}`, { method: "DELETE" }),
  search: (q: string) => request<Trip[]>(`/api/v1/trips/search?q=${encodeURIComponent(q)}`),
};

// ── Trip Items ─────────────────────────────────────────────────────────────

export type TripItem = {
  id: string;
  trip_id: string;
  type: string;
  title: string;
  raw_text: string | null;
  parsed_data: Record<string, unknown> | null;
  event_at: string | null;
  event_end_at: string | null;
  booking_ref: string | null;
  provider: string | null;
  created_at: string;
};

export const itemsApi = {
  list: (tripId: string) => request<TripItem[]>(`/api/v1/trips/${tripId}/items`),
  delete: (tripId: string, itemId: string) =>
    request<void>(`/api/v1/trips/${tripId}/items/${itemId}`, { method: "DELETE" }),
};

// ── Chaos Inbox ────────────────────────────────────────────────────────────

export type InboxItem = {
  id: string;
  raw_content: string | null;
  source: string | null;
  status: string;
  parsed_data: Record<string, unknown> | null;
  created_at: string;
};

export const inboxApi = {
  list: (status = "pending") => request<InboxItem[]>(`/api/v1/inbox?status_filter=${status}`),
  assign: (inboxId: string, tripId: string, type = "other") =>
    request<{ trip_item_id: string; title: string; event_at: string | null }>(`/api/v1/inbox/${inboxId}/assign`, {
      method: "POST",
      body: JSON.stringify({ trip_id: tripId, type }),
    }),
  reject: (inboxId: string) => request<void>(`/api/v1/inbox/${inboxId}`, { method: "DELETE" }),
};

// ── User / Plan ────────────────────────────────────────────────────────────

export type UserPlan = {
  id: string;
  plan: "free" | "pro";
  plan_expires_at: string | null;
  free_daily_parses: number;
  free_max_trips: number;
  is_pro: boolean;
  telegram_linked: boolean;
};

export const usersApi = {
  me: () => request<UserPlan>("/api/v1/users/me"),
  telegramPin: () => request<{ pin: string; expires_in_seconds: number }>("/api/v1/users/telegram-pin", { method: "POST" }),
  telegramUnlink: () => request<{ ok: boolean }>("/api/v1/users/telegram-unlink", { method: "DELETE" }),
};

export type CacheStats = {
  configured: boolean;
  hits: number;
  misses: number;
  key_count: number;
  hit_rate: number;
  ttl_days: number;
};

export const cacheApi = {
  stats: () => request<CacheStats>("/api/v1/cache/stats"),
};

// ── Parse ──────────────────────────────────────────────────────────────────

export const mailApi = {
  import: async (rawEmail: string, tripId?: string): Promise<unknown> => {
    const token = await getAccessToken();
    if (!token) throw new Error("Not authenticated");
    const qs = tripId ? `?trip_id=${encodeURIComponent(tripId)}` : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE_URL}/api/v1/mail/import${qs}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain" },
        body: rawEmail,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text();
        throw new ApiError(`Mail import failed: ${res.status}`, res.status, body);
      }
      return res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ApiError("Timeout: KI antwortet nicht", 408, "timeout");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  },
};

export async function parseFile(
  fileUri: string,
  mimeType: string,
  fileName: string,
  tripId?: string
): Promise<unknown> {
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");

  const form = new FormData();
  form.append("file", { uri: fileUri, type: mimeType, name: fileName } as unknown as Blob);
  if (tripId) form.append("trip_id", tripId);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/v1/parse/file`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(`Parse failed: ${res.status}`, res.status, body);
    }
    return res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ApiError("Timeout: KI antwortet nicht", 408, "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
