import { useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function UpgradeCancelScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const t = setTimeout(() => router.replace("/(app)/trips"), 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={[s.container, { paddingTop: insets.top + 32 }]}>
      <Text style={s.icon}>←</Text>
      <Text style={s.title}>Abgebrochen</Text>
      <Text style={s.sub}>Kein Problem — du kannst jederzeit upgraden.</Text>
      <TouchableOpacity style={s.btn} onPress={() => router.replace("/(app)/trips")}>
        <Text style={s.btnText}>Zurück</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a", alignItems: "center", justifyContent: "center", padding: 32 },
  icon: { fontSize: 48, color: "#6666aa", marginBottom: 24 },
  title: { fontSize: 24, fontWeight: "700", color: "#fff", marginBottom: 12 },
  sub: { fontSize: 15, color: "#6666aa", textAlign: "center", lineHeight: 22, marginBottom: 40 },
  btn: { backgroundColor: "#2a2a4e", paddingVertical: 14, paddingHorizontal: 40, borderRadius: 12 },
  btnText: { color: "#a5b4fc", fontWeight: "600", fontSize: 15 },
});
