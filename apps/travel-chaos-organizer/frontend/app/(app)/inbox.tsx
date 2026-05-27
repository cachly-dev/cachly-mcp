import { useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, ScrollView, StyleSheet, Text,
  TouchableOpacity, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTrips } from "../../hooks/useTrips";
import { ApiError, inboxApi, InboxItem } from "../../lib/api";
import { useInbox } from "../../hooks/useInbox";
import SwipeableInboxItem from "../../components/SwipeableInboxItem";
import BottomSheet from "../../components/BottomSheet";
import { haptics } from "../../lib/haptics";
import { TripCardSkeleton } from "../../components/Skeleton";
import { useToast } from "../../components/ToastContext";

export default function InboxScreen() {
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const { items, loading, refresh } = useInbox();
  const { trips } = useTrips();
  const [selected, setSelected] = useState<InboxItem | null>(null);
  const [assigning, setAssigning] = useState(false);
  const assigningRef = useRef<boolean>(false);

  async function openAssign(item: InboxItem) {
    await haptics.tap();
    setSelected(item);
  }

  async function assign(tripId: string) {
    if (!selected) return;
    if (assigningRef.current) return;
    assigningRef.current = true;
    setAssigning(true);
    try {
      await inboxApi.assign(selected.id, tripId, (selected.parsed_data?.type as string) ?? "other");
      await haptics.success();
      showToast("Dem Trip zugeordnet ✓", "success");
      setSelected(null);
      await refresh();
    } catch (err) {
      await haptics.error();
      if (err instanceof ApiError && err.status === 429) {
        showToast("Tageslimit erreicht (50 Parses). Upgrade auf Pro.", "warning");
      } else {
        showToast("Zuordnung fehlgeschlagen", "error");
      }
      setSelected(null);
    } finally {
      setAssigning(false);
      assigningRef.current = false;
    }
  }

  async function reject(id: string) {
    await haptics.warning();
    await inboxApi.reject(id);
    showToast("Eintrag abgelehnt", "warning");
    await refresh();
  }

  if (loading && items.length === 0) {
    return (
      <View style={s.container}>
        <View style={{ padding: 16, gap: 10 }}>
          {[1, 2, 3].map((k) => <TripCardSkeleton key={k} />)}
        </View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={[
          s.list,
          { paddingBottom: insets.bottom + 24 },
          items.length === 0 && s.emptyFlex,
        ]}
        refreshing={loading}
        onRefresh={refresh}
        ListHeaderComponent={
          items.length > 0
            ? <Text style={s.hint}>← Wischen zum Zuweisen · Ablehnen →</Text>
            : null
        }
        ListEmptyComponent={
          <View style={s.empty}>
            <Text style={s.emptyIcon}>🎉</Text>
            <Text style={s.emptyTitle}>Inbox leer!</Text>
            <Text style={s.emptySub}>Alle Dokumente sind sortiert.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <SwipeableInboxItem
            item={item}
            onAssign={() => openAssign(item)}
            onReject={() => reject(item.id)}
          />
        )}
      />

      <BottomSheet visible={!!selected} onClose={() => setSelected(null)} heightFraction={0.55}>
        <Text style={s.sheetTitle}>Welchem Trip zuweisen?</Text>

        {trips.length === 0 ? (
          <Text style={s.noTrips}>Noch keine Trips vorhanden.</Text>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
            {trips.map((trip) => (
              <TouchableOpacity
                key={trip.id}
                style={[s.tripRow, { opacity: assigning ? 0.5 : 1 }]}
                onPress={() => assign(trip.id)}
                disabled={assigning}
                activeOpacity={0.7}
              >
                <View style={s.tripRowInner}>
                  <Text style={s.tripName}>{trip.name}</Text>
                  {trip.start_date && <Text style={s.tripDate}>{trip.start_date}</Text>}
                </View>
                {assigning ? <ActivityIndicator color="#4f46e5" /> : <Text style={s.arrow}>›</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </BottomSheet>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  list: { padding: 16, gap: 0 },
  emptyFlex: { flex: 1 },
  hint: { color: "#3a3a5e", fontSize: 12, textAlign: "center", marginBottom: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48, gap: 12 },
  emptyIcon: { fontSize: 64 },
  emptyTitle: { fontSize: 22, fontWeight: "700", color: "#fff" },
  emptySub: { fontSize: 15, color: "#6666aa" },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: "#fff", marginBottom: 16 },
  noTrips: { color: "#6666aa", fontSize: 14, textAlign: "center", padding: 24 },
  tripRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 16, paddingHorizontal: 4,
    borderBottomWidth: 1, borderBottomColor: "#2a2a4e",
    minHeight: 56,
  },
  tripRowInner: { flex: 1, gap: 2 },
  tripName: { color: "#fff", fontSize: 16, fontWeight: "500" },
  tripDate: { color: "#6666aa", fontSize: 13 },
  arrow: { color: "#4f46e5", fontSize: 22, fontWeight: "300" },
});
