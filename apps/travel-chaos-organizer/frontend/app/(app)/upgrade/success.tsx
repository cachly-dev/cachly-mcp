import { useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function UpgradeSuccessScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session_id } = useLocalSearchParams<{ session_id?: string }>();

  useEffect(() => {
    const t = setTimeout(() => router.replace("/(app)/trips"), 3000);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={[s.container, { paddingTop: insets.top + 32 }]}>
      <Text style={s.icon}>✦</Text>
      <Text style={s.title}>Willkommen bei Pro!</Text>
      <Text style={s.sub}>Dein Upgrade war erfolgreich. Alle Features sind jetzt freigeschaltet.</Text>
      <TouchableOpacity style={s.btn} onPress={() => router.replace("/(app)/trips")}>
        <Text style={s.btnText}>Los geht's</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a", alignItems: "center", justifyContent: "center", padding: 32 },
  icon: { fontSize: 64, color: "#4f46e5", marginBottom: 24 },
  title: { fontSize: 28, fontWeight: "800", color: "#fff", marginBottom: 12, textAlign: "center" },
  sub: { fontSize: 16, color: "#6666aa", textAlign: "center", lineHeight: 24, marginBottom: 40 },
  btn: { backgroundColor: "#4f46e5", paddingVertical: 16, paddingHorizontal: 48, borderRadius: 14 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
