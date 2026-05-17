import { Stack, useRouter } from "expo-router";
import { useEffect } from "react";
import { initDb } from "../lib/db";
import { initQueue } from "../lib/offlineQueue";
import { useNetworkSync } from "../hooks/useNetworkSync";
import { requestNotificationPermission } from "../lib/notifications";
import { onShareIntent, getInitialShareIntent } from "../lib/shareIntent";
import { ToastProvider, useToast } from "../components/ToastContext";

function SyncManager() {
  const { showToast } = useToast();
  useNetworkSync(({ succeeded }) => {
    if (succeeded > 0) showToast(`${succeeded} Änderung${succeeded > 1 ? "en" : ""} synchronisiert`, "success");
  });
  return null;
}

function ShareIntentHandler() {
  const router = useRouter();

  useEffect(() => {
    // Handle share intent that launched the app
    getInitialShareIntent().then((file) => {
      if (file) router.push({ pathname: "/(app)/trips", params: { sharedUri: file.uri, sharedMime: file.mimeType, sharedName: file.name } });
    });

    // Handle share intents while app is running
    const unsub = onShareIntent((file) => {
      router.push({ pathname: "/(app)/trips", params: { sharedUri: file.uri, sharedMime: file.mimeType, sharedName: file.name } });
    });
    return unsub;
  }, []);

  return null;
}

export default function RootLayout() {
  useEffect(() => {
    initDb();
    initQueue();
    requestNotificationPermission().catch(() => {});
  }, []);

  return (
    <ToastProvider>
      <SyncManager />
      <ShareIntentHandler />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
    </ToastProvider>
  );
}
