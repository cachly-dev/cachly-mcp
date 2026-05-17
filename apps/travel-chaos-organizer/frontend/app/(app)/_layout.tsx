import { Tabs } from "expo-router";
import { Text } from "react-native";

const TAB_ICON: Record<string, string> = {
  trips: "🗺️", search: "🔍", inbox: "📥", settings: "⚙️",
};

function Icon({ name, focused }: { name: string; focused: boolean }) {
  return <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}>{TAB_ICON[name]}</Text>;
}

export default function AppLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: "#1a1a2e" },
      headerTintColor: "#fff",
      headerTitleStyle: { fontWeight: "700" },
      tabBarStyle: { backgroundColor: "#1a1a2e", borderTopColor: "#2a2a4e", paddingTop: 6 },
      tabBarActiveTintColor: "#4f46e5",
      tabBarInactiveTintColor: "#6666aa",
      tabBarLabelStyle: { fontSize: 11, marginBottom: 2 },
    }}>
      <Tabs.Screen name="trips" options={{ title: "Reisen", tabBarLabel: "Reisen", tabBarIcon: ({ focused }) => <Icon name="trips" focused={focused} /> }} />
      <Tabs.Screen name="search" options={{ title: "Suche", tabBarLabel: "Suche", tabBarIcon: ({ focused }) => <Icon name="search" focused={focused} /> }} />
      <Tabs.Screen name="inbox" options={{ title: "Chaos Inbox", tabBarLabel: "Inbox", tabBarIcon: ({ focused }) => <Icon name="inbox" focused={focused} /> }} />
      <Tabs.Screen name="settings" options={{ title: "Einstellungen", tabBarLabel: "Mehr", tabBarIcon: ({ focused }) => <Icon name="settings" focused={focused} /> }} />
      <Tabs.Screen name="trips/[id]" options={{ href: null }} />
    </Tabs>
  );
}
