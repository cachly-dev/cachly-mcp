import { useState, useEffect } from "react";
import {
  Alert, Linking, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { logout } from "../../lib/auth";
import { clearCache, cacheSizeBytes } from "../../lib/fileCache";
import { purgeFailed, getPending } from "../../lib/offlineQueue";
import { haptics } from "../../lib/haptics";
import { useQuota } from "../../lib/quota";

const OLLAMA_MODELS = ["llama3.2-vision", "llava", "llava-phi3", "bakllava"];

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { plan, isPro } = useQuota();
  const [cacheSize, setCacheSize] = useState(0);
  const [queueSize, setQueueSize] = useState(0);
  const [loggingOut, setLoggingOut] = useState(false);
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
    Alert.alert("Abmelden", "Wirklich abmelden?", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Abmelden",
        style: "destructive",
        onPress: async () => {
          setLoggingOut(true);
          await haptics.tap();
          await logout();
          router.replace("/(auth)/login");
        },
      },
    ]);
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 32 }]}
    >
      {/* Plan section */}
      <Text style={s.sectionTitle}>Mein Plan</Text>
      <View style={s.planCard}>
        <View style={s.planRow}>
          <Text style={s.planName}>{isPro ? "✦ Pro" : "Free"}</Text>
          {plan?.plan_expires_at && (
            <Text style={s.planExpiry}>
              bis {new Date(plan.plan_expires_at).toLocaleDateString("de")}
            </Text>
          )}
        </View>
        {!isPro && (
          <View style={s.limits}>
            <Text style={s.limitText}>
              {plan?.free_daily_parses ?? 50} KI-Parses / Tag
            </Text>
            <Text style={s.limitText}>
              max. {plan?.free_max_trips ?? 3} Trips
            </Text>
          </View>
        )}
        {!isPro && (
          <TouchableOpacity
            style={s.upgradeBtn}
            onPress={() => Linking.openURL(process.env.EXPO_PUBLIC_UPGRADE_URL ?? "https://tco.app/upgrade")}
            activeOpacity={0.8}
          >
            <Text style={s.upgradeBtnText}>Auf Pro upgraden ✦</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={s.sectionTitle}>KI Modell</Text>
      <View style={s.card}>
        {OLLAMA_MODELS.map((model) => (
          <TouchableOpacity
            key={model}
            style={s.row}
            onPress={async () => { await haptics.tap(); setSelectedModel(model); }}
            accessibilityLabel={`Modell ${model} auswählen`}
            accessibilityRole="button"
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
        <TouchableOpacity
          style={s.row}
          onPress={handleClearCache}
          accessibilityLabel="Cache leeren"
          accessibilityRole="button"
        >
          <Text style={[s.rowText, s.danger]}>Cache leeren</Text>
        </TouchableOpacity>

        <View style={[s.infoRow, { marginTop: 0 }]}>
          <Text style={s.rowText}>Offline Queue</Text>
          <Text style={s.rowValue}>{queueSize} Einträge</Text>
        </View>
        {queueSize > 0 && (
          <TouchableOpacity
            style={s.row}
            onPress={handlePurgeQueue}
            accessibilityLabel="Offline-Queue zurücksetzen"
            accessibilityRole="button"
          >
            <Text style={[s.rowText, s.danger]}>Queue zurücksetzen</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Links section */}
      <Text style={s.sectionTitle}>Info</Text>
      <View style={s.card}>
        <TouchableOpacity
          style={s.row}
          onPress={() => Linking.openURL(process.env.EXPO_PUBLIC_PRIVACY_URL ?? "https://tco.app/privacy")}
          accessibilityRole="link"
        >
          <Text style={s.rowText}>Datenschutz</Text>
          <Text style={s.rowChevron}>›</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.row}
          onPress={() => Linking.openURL(process.env.EXPO_PUBLIC_TERMS_URL ?? "https://tco.app/terms")}
          accessibilityRole="link"
        >
          <Text style={s.rowText}>Nutzungsbedingungen</Text>
          <Text style={s.rowChevron}>›</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.row, { borderBottomWidth: 0 }]}
          onPress={() => Linking.openURL(`mailto:${process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? "hello@tco.app"}`)}
          accessibilityRole="link"
        >
          <Text style={s.rowText}>Support kontaktieren</Text>
          <Text style={s.rowChevron}>›</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.sectionTitle}>Account</Text>
      <View style={s.card}>
        <TouchableOpacity
          style={[s.row, s.dangerRow, { borderBottomWidth: 0 }]}
          onPress={handleLogout}
          disabled={loggingOut}
          accessibilityLabel="Abmelden"
          accessibilityRole="button"
        >
          <Text style={s.dangerText}>Abmelden</Text>
        </TouchableOpacity>
      </View>

      {/* Cachly badge — cross-promotion */}
      <TouchableOpacity
        style={s.cachlyBadge}
        onPress={() => Linking.openURL("https://cachly.dev")}
        activeOpacity={0.75}
        accessibilityLabel="Powered by Cachly — cachly.dev besuchen"
        accessibilityRole="link"
      >
        <View style={s.cachlyInner}>
          <View style={s.cachlyDot} />
          <Text style={s.cachlyText}>Powered by</Text>
          <Text style={s.cachlyBrand}>Cachly</Text>
        </View>
        <Text style={s.cachlySubtext}>
          KI-Ergebnisse werden per Cachly Redis gecacht —{"\n"}
          kein zweiter AI-Call für dasselbe Dokument.
        </Text>
      </TouchableOpacity>

      <Text style={s.version}>Travel Chaos Organizer v0.1.0</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  content: { padding: 20, gap: 8 },
  sectionTitle: {
    color: "#6666aa", fontSize: 12, fontWeight: "600",
    letterSpacing: 0.8, textTransform: "uppercase",
    marginTop: 16, marginBottom: 4, paddingHorizontal: 4,
  },
  planCard: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 20, gap: 12, borderWidth: 1, borderColor: "#2a2a4e" },
  planRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  planName: { fontSize: 22, fontWeight: "800", color: "#fff" },
  planExpiry: { fontSize: 12, color: "#6666aa" },
  limits: { gap: 4 },
  limitText: { fontSize: 13, color: "#6666aa" },
  upgradeBtn: { backgroundColor: "#4f46e5", paddingVertical: 14, borderRadius: 12, alignItems: "center", marginTop: 4 },
  upgradeBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, borderWidth: 1, borderColor: "#2a2a4e", overflow: "hidden" },
  row: { paddingVertical: 14, paddingHorizontal: 18, borderBottomWidth: 1, borderBottomColor: "#2a2a4e", flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  infoRow: {
    paddingVertical: 14, paddingHorizontal: 18,
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    borderBottomWidth: 1, borderBottomColor: "#2a2a4e",
  },
  rowText: { color: "#e2e8f0", fontSize: 15 },
  rowValue: { color: "#6666aa", fontSize: 14 },
  rowChevron: { color: "#6666aa", fontSize: 18 },
  check: { color: "#4f46e5", fontSize: 16, fontWeight: "700" },
  danger: { color: "#f87171" },
  dangerRow: { borderWidth: 1, borderColor: "#ff6b6b22", backgroundColor: "#ff6b6b11" },
  dangerText: { color: "#ff8888", fontSize: 15, fontWeight: "600" },
  hint: { color: "#4a4a7a", fontSize: 12, padding: 16, lineHeight: 18 },

  // Cachly badge
  cachlyBadge: {
    marginTop: 32,
    backgroundColor: "#1a1a2e",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#4f46e533",
    padding: 16,
    gap: 8,
  },
  cachlyInner: { flexDirection: "row", alignItems: "center", gap: 8 },
  cachlyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#4f46e5" },
  cachlyText: { color: "#6666aa", fontSize: 13 },
  cachlyBrand: { color: "#a5b4fc", fontSize: 14, fontWeight: "700" },
  cachlySubtext: { color: "#3a3a5e", fontSize: 12, lineHeight: 18 },

  version: { color: "#3a3a5e", fontSize: 12, textAlign: "center", marginTop: 20 },
});
