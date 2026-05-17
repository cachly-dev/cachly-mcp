import { useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, Modal, StyleSheet,
  Text, TouchableOpacity, View,
} from "react-native";
import { useTrips } from "../../hooks/useTrips";
import { inboxApi, InboxItem } from "../../lib/api";
import { useInbox } from "../../hooks/useInbox";

export default function InboxScreen() {
  const { items, loading, refresh } = useInbox();
  const { trips } = useTrips();
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [assigning, setAssigning] = useState(false);

  async function assign(tripId: string) {
    if (!selected) return;
    setAssigning(true);
    try {
      await inboxApi.assign(selected.id, tripId, (selected.parsed_data?.type as string) ?? "other");
      setSelected(null);
      await refresh();
    } catch {
      Alert.alert("Fehler", "Zuweisung fehlgeschlagen.");
    } finally {
      setAssigning(false);
    }
  }

  async function reject(id: string) {
    Alert.alert("Ablehnen?", "Das Item wird als abgelehnt markiert.", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Ablehnen", style: "destructive",
        onPress: async () => {
          await inboxApi.reject(id);
          await refresh();
        },
      },
    ]);
  }

  if (loading && items.length === 0) {
    return <View style={s.center}><ActivityIndicator color="#4f46e5" size="large" /></View>;
  }

  return (
    <View style={s.container}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={items.length === 0 ? s.emptyContainer : s.list}
        refreshing={loading}
        onRefresh={refresh}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>🎉</Text>
            <Text style={s.emptyTitle}>Inbox leer!</Text>
            <Text style={s.emptySub}>Alle Dokumente sind sortiert.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={s.card}>
            <View style={s.cardHeader}>
              <Text style={s.cardType}>{typeIcon(item.parsed_data?.type as string)}</Text>
              <View style={s.cardMeta}>
                <Text style={s.cardTitle} numberOfLines={1}>
                  {(item.parsed_data?.title as string) ?? "Unbekanntes Dokument"}
                </Text>
                <Text style={s.cardSource}>{item.source ?? "Unbekannte Quelle"}</Text>
              </View>
            </View>
            {item.parsed_data?.raw_summary && (
              <Text style={s.cardSummary} numberOfLines={2}>
                {item.parsed_data.raw_summary as string}
              </Text>
            )}
            <View style={s.cardActions}>
              <TouchableOpacity style={s.assignBtn} onPress={() => setSelected(item)}>
                <Text style={s.assignText}>Trip zuweisen</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.rejectBtn} onPress={() => reject(item.id)}>
                <Text style={s.rejectText}>Ablehnen</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      />

      <Modal visible={!!selected} transparent animationType="slide">
        <View style={s.modalOverlay}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>Welchem Trip zuweisen?</Text>
            {trips.length === 0 && (
              <Text style={s.noTrips}>Noch keine Trips. Erstelle zuerst einen Trip.</Text>
            )}
            {trips.map((trip) => (
              <TouchableOpacity key={trip.id} style={s.tripRow} onPress={() => assign(trip.id)} disabled={assigning}>
                <Text style={s.tripRowText}>{trip.name}</Text>
                {trip.start_date && <Text style={s.tripRowDate}>{trip.start_date}</Text>}
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={s.cancelBtn} onPress={() => setSelected(null)}>
              <Text style={s.cancelText}>Abbrechen</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function typeIcon(type?: string): string {
  const icons: Record<string, string> = {
    flight: "✈️", train: "🚂", bus: "🚌", hotel: "🏨",
    rental_car: "🚗", activity: "🎡", transfer: "🚕", document: "📄",
  };
  return icons[type ?? ""] ?? "📋";
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0f0f1a" },
  list: { padding: 16, gap: 12 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyIcon: { fontSize: 64, marginBottom: 16 },
  emptyTitle: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptySub: { fontSize: 15, color: "#6666aa" },
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 16, gap: 10, borderWidth: 1, borderColor: "#2a2a4e" },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  cardType: { fontSize: 28 },
  cardMeta: { flex: 1, gap: 2 },
  cardTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  cardSource: { color: "#6666aa", fontSize: 12 },
  cardSummary: { color: "#8888aa", fontSize: 13, lineHeight: 18 },
  cardActions: { flexDirection: "row", gap: 10 },
  assignBtn: { flex: 1, backgroundColor: "#4f46e5", borderRadius: 8, paddingVertical: 10, alignItems: "center" },
  assignText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  rejectBtn: { borderRadius: 8, paddingVertical: 10, paddingHorizontal: 16, borderWidth: 1, borderColor: "#3a3a5e" },
  rejectText: { color: "#6666aa", fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: "#000000cc", justifyContent: "flex-end" },
  modalCard: { backgroundColor: "#1a1a2e", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 28, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#fff", marginBottom: 4 },
  noTrips: { color: "#6666aa", fontSize: 14, textAlign: "center", padding: 16 },
  tripRow: { backgroundColor: "#0f0f1a", borderRadius: 10, padding: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tripRowText: { color: "#fff", fontSize: 15, fontWeight: "500" },
  tripRowDate: { color: "#6666aa", fontSize: 13 },
  cancelBtn: { marginTop: 4, padding: 12, alignItems: "center" },
  cancelText: { color: "#6666aa", fontSize: 15 },
});
