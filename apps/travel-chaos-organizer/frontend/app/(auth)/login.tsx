import { useState } from "react";
import {
  ActivityIndicator, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { login } from "../../lib/auth";
import { haptics } from "../../lib/haptics";

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    await haptics.tap();
    try {
      const tokens = await login();
      if (tokens) {
        await haptics.success();
        router.replace("/(app)/trips");
      } else {
        setError("Login abgebrochen.");
      }
    } catch {
      await haptics.error();
      setError("Login fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[s.container, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
      {/* Top spacer for visual balance */}
      <View style={{ flex: 1 }} />

      <View style={s.hero}>
        <Text style={s.logo}>✈️</Text>
        <Text style={s.title}>Travel Chaos{"\n"}Organizer</Text>
        <Text style={s.subtitle}>Deine Reisen. Endlich organisiert.</Text>
      </View>

      <View style={{ flex: 1.5 }} />

      <View style={s.bottom}>
        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorText}>⚠️  {error}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.button, loading && s.buttonLoading]}
          onPress={handleLogin}
          disabled={loading}
          activeOpacity={0.85}
        >
          {loading
            ? <ActivityIndicator color="#fff" />
            : <Text style={s.buttonText}>Mit Keycloak anmelden</Text>}
        </TouchableOpacity>

        <Text style={s.hint}>Dein Account wird von deinem selbst-gehosteten{"\n"}Keycloak verwaltet.</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a", paddingHorizontal: 32 },
  hero: { alignItems: "center", gap: 12 },
  logo: { fontSize: 80 },
  title: { fontSize: 34, fontWeight: "800", color: "#fff", textAlign: "center", lineHeight: 42, letterSpacing: -0.5 },
  subtitle: { fontSize: 16, color: "#6666aa", textAlign: "center", lineHeight: 24 },
  bottom: { gap: 16 },
  errorBox: { backgroundColor: "#ff6b6b22", borderRadius: 12, padding: 12, borderWidth: 1, borderColor: "#ff6b6b44" },
  errorText: { color: "#ff8888", textAlign: "center", fontSize: 14, lineHeight: 20 },
  button: {
    backgroundColor: "#4f46e5", paddingVertical: 18, paddingHorizontal: 48,
    borderRadius: 16, alignItems: "center",
    shadowColor: "#4f46e5", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  buttonLoading: { opacity: 0.7 },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700", letterSpacing: 0.2 },
  hint: { color: "#3a3a5e", fontSize: 12, textAlign: "center", lineHeight: 18 },
});
