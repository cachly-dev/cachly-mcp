import { useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Modal, StyleSheet,
  Text, TextInput, TouchableOpacity, View, RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useTrips } from "../../hooks/useTrips";
import { tripsApi, Trip } from "../../lib/api";
import TripCard from "../../components/TripCard";

export default function TripsScreen() {
  const router = useRouter();
  const { trips, loading, error, refresh } = useTrips();
  const [modalVisible, setModalVisible] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function createTrip() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await tripsApi.create({ name: name.trim(), description: null, start_date: null, end_date: null });
      setName("");
      setModalVisible(false);
      await refresh();
    } catch {
      Alert.alert("Fehler", "Trip konnte nicht erstellt werden.");
    } finally {
      setSaving(false);
    }
  }

  if (loading && trips.length === 0) {
    return <View style={s.center}><ActivityIndicator color="#4f46e5" size="large" /></View>;
  }

  return (
    <View style={s.container}>
      {error && <Text style={s.errorBanner}>Offline — zeige gespeicherte Daten</Text>}

      <FlatList
        data={trips}
        keyExtractor={(t) => t.id}
        contentContainerStyle={trips.length === 0 ? s.emptyContainer : s.list}
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

      <TouchableOpacity style={s.fab} onPress={() => setModalVisible(true)}>
        <Text style={s.fabText}>+</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Neuer Trip</Text>
            <TextInput
              style={s.input}
              placeholder="z.B. Barcelona Sommer 2024"
              placeholderTextColor="#6666aa"
              value={name}
              onChangeText={setName}
              autoFocus
            />
            <View style={s.modalButtons}>
              <TouchableOpacity style={s.cancelBtn} onPress={() => setModalVisible(false)}>
                <Text style={s.cancelText}>Abbrechen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.saveBtn} onPress={createTrip} disabled={saving || !name.trim()}>
                {saving
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={s.saveText}>Erstellen</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0f0f1a" },
  list: { padding: 16, gap: 12 },
  emptyContainer: { flex: 1 },
  errorBanner: { backgroundColor: "#7c3aed33", color: "#c4b5fd", padding: 8, textAlign: "center", fontSize: 13 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptySubtitle: { fontSize: 15, color: "#6666aa", textAlign: "center", lineHeight: 22 },
  fab: { position: "absolute", bottom: 32, right: 24, width: 56, height: 56, borderRadius: 28, backgroundColor: "#4f46e5", alignItems: "center", justifyContent: "center", elevation: 6 },
  fabText: { color: "#fff", fontSize: 28, lineHeight: 32 },
  modalOverlay: { flex: 1, backgroundColor: "#000000cc", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#1a1a2e", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, gap: 16 },
  modalTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  input: { backgroundColor: "#0f0f1a", borderRadius: 10, padding: 14, color: "#fff", fontSize: 16, borderWidth: 1, borderColor: "#2a2a4e" },
  modalButtons: { flexDirection: "row", gap: 12, justifyContent: "flex-end" },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: "#2a2a4e" },
  cancelText: { color: "#8888aa", fontSize: 15 },
  saveBtn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10, backgroundColor: "#4f46e5", minWidth: 100, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
