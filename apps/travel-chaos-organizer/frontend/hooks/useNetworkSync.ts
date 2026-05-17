/**
 * Runs the offline queue drain whenever the app comes to foreground
 * and network is available.
 *
 * Import once in the root layout — all other screens benefit automatically.
 */
import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import { drainQueue } from "../lib/offlineQueue";
import { getAccessToken } from "../lib/auth";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL!;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function useNetworkSync(onSynced?: (result: { succeeded: number; failed: number }) => void) {
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (next) => {
      if (appState.current.match(/inactive|background/) && next === "active") {
        const result = await drainQueue(authHeaders, BASE_URL);
        if (result.succeeded > 0) onSynced?.(result);
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, []);
}
