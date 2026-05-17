import { Tabs } from "expo-router";

export default function AppLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: "#1a1a2e" },
      headerTintColor: "#fff",
      tabBarStyle: { backgroundColor: "#1a1a2e", borderTopColor: "#2a2a4e" },
      tabBarActiveTintColor: "#4f46e5",
      tabBarInactiveTintColor: "#6666aa",
    }}>
      <Tabs.Screen name="trips" options={{ title: "Meine Reisen", tabBarLabel: "Reisen", tabBarIcon: () => null }} />
      <Tabs.Screen name="trips/[id]" options={{ href: null }} />
      <Tabs.Screen name="inbox" options={{ title: "Chaos Inbox", tabBarLabel: "Inbox", tabBarIcon: () => null }} />
    </Tabs>
  );
}
