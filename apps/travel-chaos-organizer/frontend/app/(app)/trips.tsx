import { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView,
  Platform, RefreshControl, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTrips } from "../../hooks/useTrips";
import TripCard from "../../components/TripCard";
import BottomSheet from "../../components/BottomSheet";
import { TripCardSkeleton } from "../../components/Skeleton";
import { haptics } from "../../lib/haptics";
import { scheduleAllTripReminders } from "../../lib/notifications";

export default function TripsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { trips, loading, error, refresh, createOffline } = useTrips();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  // Schedule reminders whenever trip list changes
  useEffect(() => {
    if (trips.length > 0) scheduleAllTripReminders(trips).catch(() => {});
  }, [trips]);

  async function createTrip() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createOffline({ name: name.trim(), description: null, start_date: null, end_date: null });
      await haptics.success();
      setName("");
      setSheetVisible(false);
    } catch {
      await haptics.error();
      Alert.alert("Fehler", "Trip konnte nicht erstellt werden.");
    } finally {
      setSaving(false);
    }
  }

  function openSheet() {
    haptics.tap();
    setSheetVisible(true);
  }

  if (loading && trips.length === 0) {
    return (
      <View style={s.container}>
        <View style={s.list}>
          {[1, 2, 3].map((k) => <TripCardSkeleton key={k} />)}
        </View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      {error && <Text style={s.errorBanner}>Offline — zeige gespeicherte Daten</Text>}

      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        contentContainerStyle={[
          trips.length === 0 ? s.emptyContainer : s.list,
          { paddingBottom: insets.bottom + 80 },
        ]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor="#4f46e5" />}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>🗺️</Text>
            <Text style={s.emptyTitle}>Noch keine Reisen</Text>
            <Text style={s.emptySubtitle}>Erstelle deinen ersten Trip und wirf deine Buchungen rein.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <TripCard trip={item} onPress={() => router.push(`/(app)/trips/${item.id}`)} />
        )}
      />

      <TouchableOpacity
        style={[s.fab, { bottom: insets.bottom + 24 }]}
        onPress={openSheet}
        activeOpacity={0.85}
      >
        <Text style={s.fabText}>+</Text>
      </TouchableOpacity>

      <BottomSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} heightFraction={0.45}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
          <Text style={s.sheetTitle}>Neuer Trip</Text>
          <TextInput
            style={s.input}
            placeholder="z.B. Barcelona Sommer 2024"
            placeholderTextColor="#6666aa"
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={createTrip}
          />
          <View style={s.sheetButtons}>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setSheetVisible(false)}>
              <Text style={s.cancelText}>Abbrechen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.saveBtn, (!name.trim() || saving) && s.saveBtnDisabled]}
              onPress={createTrip}
              disabled={saving || !name.trim()}
            >
              {saving
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.saveText}>Erstellen</Text>}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </BottomSheet>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  list: { padding: 16, gap: 12 },
  emptyContainer: { flex: 1 },
  errorBanner: { backgroundColor: "#7c3aed33", color: "#c4b5fd", padding: 8, textAlign: "center", fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: "#6666aa", textAlign: "center", lineHeight: 22 },
  fab: {
    position: "absolute", right: 24, width: 56, height: 56,
    borderRadius: 28, backgroundColor: "#4f46e5",
    alignItems: "center", justifyContent: "center",
    elevation: 6, shadowColor: "#4f46e5", shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  fabText: { color: "#fff", fontSize: 28, lineHeight: 32 },
  sheetTitle: { fontSize: 20, fontWeight: "700", color: "#fff", marginBottom: 16 },
  input: {
    backgroundColor: "#0f0f1a", borderRadius: 12, padding: 14,
    color: "#fff", fontSize: 16, borderWidth: 1, borderColor: "#2a2a4e", marginBottom: 16,
  },
  sheetButtons: { flexDirection: "row", gap: 12, justifyContent: "flex-end" },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: "#2a2a4e" },
  cancelText: { color: "#8888aa", fontSize: 15 },
  saveBtn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10, backgroundColor: "#4f46e5", minWidth: 100, alignItems: "center" },
  saveBtnDisabled: { opacity: 0.45 },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
