import { useState } from "react";
import {
  ActivityIndicator, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import { login } from "../../lib/auth";

export default function LoginScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLogin() {
    setLoading(true);
    setError(null);
    try {
      const tokens = await login();
      if (tokens) {
        router.replace("/(app)/trips");
      } else {
        setError("Login abgebrochen.");
      }
    } catch (e) {
      setError("Login fehlgeschlagen. Bitte erneut versuchen.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={s.container}>
      <Text style={s.logo}>✈️</Text>
      <Text style={s.title}>Travel Chaos{"\n"}Organizer</Text>
      <Text style={s.subtitle}>Deine Reisen. Endlich organisiert.</Text>

      {error && <Text style={s.error}>{error}</Text>}

      <TouchableOpacity style={s.button} onPress={handleLogin} disabled={loading}>
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={s.buttonText}>Anmelden</Text>}
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1a1a2e", alignItems: "center", justifyContent: "center", padding: 32 },
  logo: { fontSize: 72, marginBottom: 16 },
  title: { fontSize: 32, fontWeight: "700", color: "#fff", textAlign: "center", lineHeight: 40 },
  subtitle: { fontSize: 16, color: "#8888aa", marginTop: 8, marginBottom: 48, textAlign: "center" },
  error: { color: "#ff6b6b", marginBottom: 16, textAlign: "center" },
  button: { backgroundColor: "#4f46e5", paddingVertical: 16, paddingHorizontal: 48, borderRadius: 12, minWidth: 200, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 18, fontWeight: "600" },
});
