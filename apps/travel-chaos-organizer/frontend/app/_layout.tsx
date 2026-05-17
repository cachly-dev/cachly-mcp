import { Stack } from "expo-router";
import { useEffect } from "react";
import { Alert } from "react-native";
import { initDb } from "../lib/db";
import { initQueue } from "../lib/offlineQueue";
import { useNetworkSync } from "../hooks/useNetworkSync";

function SyncManager() {
  useNetworkSync(({ succeeded }) => {
    if (succeeded > 0) Alert.alert("Sync", `${succeeded} Änderung${succeeded > 1 ? "en" : ""} synchronisiert.`);
  });
  return null;
}

export default function RootLayout() {
  useEffect(() => {
    initDb();
    initQueue();
  }, []);

  return (
    <>
      <SyncManager />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(app)" />
      </Stack>
    </>
  );
}
