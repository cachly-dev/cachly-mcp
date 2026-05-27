/**
 * Runs the offline queue drain whenever the app comes to foreground
 * or network connectivity is restored.
 *
 * Import once in the root layout — all other screens benefit automatically.
 */
import { useEffect, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import * as Network from "expo-network";
import { drainQueue, processQueue, setQueueErrorCallback } from "../lib/offlineQueue";
import { getAccessToken } from "../lib/auth";
import { useToast } from "../components/ToastContext";

const BASE_URL = process.env.EXPO_PUBLIC_API_URL!;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

export function useNetworkSync(onSynced?: (result: { succeeded: number; failed: number }) => void) {
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const wasOffline = useRef(false);
  const { showToast } = useToast();

  useEffect(() => {
    setQueueErrorCallback((count) => {
      showToast(`${count} gespeicherte Änderungen konnten nicht synchronisiert werden`, "error");
    });
    // Drain on foreground
    const appStateSub = AppState.addEventListener("change", async (next) => {
      if (appState.current.match(/inactive|background/) && next === "active") {
        const result = await drainQueue(authHeaders, BASE_URL);
        if (result.succeeded > 0) onSynced?.(result);
      }
      appState.current = next;
    });

    // Drain on network recovery by polling every 5 s (expo-network has no push listener)
    const interval = setInterval(async () => {
      if (appState.current !== "active") return;
      const net = await Network.getNetworkStateAsync();
      if (!net.isConnected) {
        wasOffline.current = true;
        return;
      }
      if (wasOffline.current) {
        wasOffline.current = false;
        const result = await processQueue(authHeaders, BASE_URL);
        if (result.succeeded > 0) onSynced?.(result);
      }
    }, 5000);

    return () => {
      appStateSub.remove();
      clearInterval(interval);
    };
  }, []);
}
