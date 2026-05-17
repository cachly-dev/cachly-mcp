import { Tabs } from "expo-router";
import { Text, View } from "react-native";
import OfflineBadge from "../../components/OfflineBadge";

const TAB_ICON: Record<string, string> = {
  trips: "🗺️", search: "🔍", inbox: "📥", settings: "⚙️",
};

const TAB_LABELS: Record<string, string> = {
  trips: "Meine Reisen", search: "Suche", inbox: "Chaos Inbox", settings: "Einstellungen",
};

function Icon({ name, focused }: { name: string; focused: boolean }) {
  return (
    <Text
      style={{ fontSize: 20, opacity: focused ? 1 : 0.5 }}
      accessibilityElementsHidden
    >
      {TAB_ICON[name]}
    </Text>
  );
}

function Header() {
  return <OfflineBadge />;
}

export default function AppLayout() {
  return (
    <Tabs screenOptions={{
      headerStyle: { backgroundColor: "#1a1a2e" },
      headerTintColor: "#fff",
      headerTitleStyle: { fontWeight: "700" },
      headerBottom: () => <Header />,
      tabBarStyle: { backgroundColor: "#1a1a2e", borderTopColor: "#2a2a4e", paddingTop: 6 },
      tabBarActiveTintColor: "#4f46e5",
      tabBarInactiveTintColor: "#6666aa",
      tabBarLabelStyle: { fontSize: 11, marginBottom: 2 },
    }}>
      <Tabs.Screen
        name="trips"
        options={{
          title: "Reisen",
          tabBarLabel: "Reisen",
          tabBarIcon: ({ focused }) => <Icon name="trips" focused={focused} />,
          tabBarAccessibilityLabel: TAB_LABELS.trips,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Suche",
          tabBarLabel: "Suche",
          tabBarIcon: ({ focused }) => <Icon name="search" focused={focused} />,
          tabBarAccessibilityLabel: TAB_LABELS.search,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Chaos Inbox",
          tabBarLabel: "Inbox",
          tabBarIcon: ({ focused }) => <Icon name="inbox" focused={focused} />,
          tabBarAccessibilityLabel: TAB_LABELS.inbox,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Einstellungen",
          tabBarLabel: "Mehr",
          tabBarIcon: ({ focused }) => <Icon name="settings" focused={focused} />,
          tabBarAccessibilityLabel: TAB_LABELS.settings,
        }}
      />
      <Tabs.Screen name="trips/[id]" options={{ href: null }} />
      <Tabs.Screen name="upgrade/success" options={{ href: null }} />
      <Tabs.Screen name="upgrade/cancel" options={{ href: null }} />
    </Tabs>
  );
}
