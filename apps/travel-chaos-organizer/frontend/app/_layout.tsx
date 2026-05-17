import { Stack } from "expo-router";
import { useEffect } from "react";
import { initDb } from "../lib/db";

export default function RootLayout() {
  useEffect(() => { initDb(); }, []);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
    </Stack>
  );
}
