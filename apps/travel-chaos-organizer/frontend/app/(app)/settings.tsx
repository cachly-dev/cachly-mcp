import { useState } from "react";
import {
  Alert, ScrollView, StyleSheet, Switch, Text,
  TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import { logout } from "../../lib/auth";
import { clearCache, cacheSizeBytes } from "../../lib/fileCache";
import { purgeFailed, getPending } from "../../lib/offlineQueue";
import { haptics } from "../../lib/haptics";
import { useEffect } from "react";

const OLLAMA_MODELS = ["llama3.2-vision", "llava", "llava-phi3", "bakllava"];

export default function SettingsScreen() {
  const router = useRouter();
  const [cacheSize, setCacheSize] = useState(0);
  const [queueSize, setQueueSize] = useState(0);
  const [selectedModel, setSelectedModel] = useState(
    process.env.EXPO_PUBLIC_OLLAMA_MODEL ?? "llama3.2-vision"
  );

  useEffect(() => {
    cacheSizeBytes().then(setCacheSize);
    setQueueSize(getPending().length);
  }, []);

  async function handleClearCache() {
    await haptics.warning();
    Alert.alert(
      "Cache leeren?",
      "Alle lokal gespeicherten Tickets und PDFs werden gelöscht.",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Leeren", style: "destructive",
          onPress: async () => {
            await clearCache();
            setCacheSize(0);
            await haptics.success();
          },
        },
      ]
    );
  }

  async function handlePurgeQueue() {
    purgeFailed(0);
    setQueueSize(0);
    await haptics.confirm();
  }

  async function handleLogout() {
    await haptics.warning();
    Alert.alert("Abmelden?", "Du wirst aus der App ausgeloggt.", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Abmelden", style: "destructive",
        onPress: async () => {
          await logout();
          router.replace("/(auth)/login");
        },
      },
    ]);
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Text style={s.sectionTitle}>KI Modell</Text>
      <View style={s.card}>
        {OLLAMA_MODELS.map((model) => (
          <TouchableOpacity
            key={model}
            style={s.row}
            onPress={async () => { await haptics.tap(); setSelectedModel(model); }}
          >
            <Text style={s.rowText}>{model}</Text>
            {selectedModel === model && <Text style={s.check}>✓</Text>}
          </TouchableOpacity>
        ))}
        <Text style={s.hint}>
          Das Modell muss auf deinem Ollama-Server verfügbar sein.{"\n"}
          Für Screenshot-Parsing wird ein Vision-Modell benötigt.
        </Text>
      </View>

      <Text style={s.sectionTitle}>Offline & Cache</Text>
      <View style={s.card}>
        <View style={s.infoRow}>
          <Text style={s.rowText}>Cache-Größe</Text>
          <Text style={s.rowValue}>{(cacheSize / 1024 / 1024).toFixed(1)} MB</Text>
        </View>
        <TouchableOpacity style={s.row} onPress={handleClearCache}>
          <Text style={[s.rowText, s.danger]}>Cache leeren</Text>
        </TouchableOpacity>

        <View style={[s.infoRow, { marginTop: 8 }]}>
          <Text style={s.rowText}>Offline Queue</Text>
          <Text style={s.rowValue}>{queueSize} Einträge</Text>
        </View>
        {queueSize > 0 && (
          <TouchableOpacity style={s.row} onPress={handlePurgeQueue}>
            <Text style={[s.rowText, s.danger]}>Queue zurücksetzen</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={s.sectionTitle}>Account</Text>
      <View style={s.card}>
        <TouchableOpacity style={s.row} onPress={handleLogout}>
          <Text style={[s.rowText, s.danger]}>Abmelden</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.version}>Travel Chaos Organizer · v0.1.0</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  content: { padding: 20, gap: 8, paddingBottom: 48 },
  sectionTitle: { color: "#6666aa", fontSize: 12, fontWeight: "600", letterSpacing: 0.8, textTransform: "uppercase", marginTop: 16, marginBottom: 4, paddingHorizontal: 4 },
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, borderWidth: 1, borderColor: "#2a2a4e", overflow: "hidden" },
  row: { paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: "#2a2a4e" },
  infoRow: { paddingVertical: 14, paddingHorizontal: 18, flexDirection: "row", justifyContent: "space-between", alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#2a2a4e" },
  rowText: { color: "#e2e8f0", fontSize: 15 },
  rowValue: { color: "#6666aa", fontSize: 14 },
  check: { color: "#4f46e5", fontSize: 16, fontWeight: "700" },
  danger: { color: "#f87171" },
  hint: { color: "#4a4a7a", fontSize: 12, padding: 16, lineHeight: 18 },
  version: { color: "#3a3a5e", fontSize: 12, textAlign: "center", marginTop: 32 },
});
