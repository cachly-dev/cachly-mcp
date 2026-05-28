import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList,
  RefreshControl, StyleSheet, Text, TextInput,
  TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTrips } from "../../hooks/useTrips";
import { ApiError, Trip, tripsApi } from "../../lib/api";
import TripCard from "../../components/TripCard";
import BottomSheet from "../../components/BottomSheet";
import { TripCardSkeleton } from "../../components/Skeleton";
import { haptics } from "../../lib/haptics";
import { scheduleAllTripReminders } from "../../lib/notifications";
import { useToast } from "../../components/ToastContext";
import { UpgradeBanner } from "../../components/UpgradeBanner";
import { TripQRModal } from "../../components/TripQRModal";
import { getLocalItems } from "../../lib/db";

function tripScore(tripId: string, hasDates: boolean): number {
  const items = getLocalItems(tripId);
  const types = items.map(i => i.type?.toLowerCase() ?? "");
  const hasFlight = types.some(t => t.includes("flight") || t.includes("flug"));
  const hasHotel = types.some(t => t.includes("hotel") || t.includes("accommodation") || t.includes("unterkunft"));
  return (hasDates ? 50 : 0) + (hasFlight ? 25 : 0) + (hasHotel ? 25 : 0);
}

type SheetMode = "create" | "edit";

export default function TripsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const { trips, loading, error, refresh, createOffline, updateOffline } = useTrips();

  const [sheetVisible, setSheetVisible] = useState(false);
  const [sheetMode, setSheetMode] = useState<SheetMode>("create");
  const [editingTrip, setEditingTrip] = useState<Trip | null>(null);
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [startDateError, setStartDateError] = useState<string | null>(null);
  const [endDateError, setEndDateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submittingRef = useRef<boolean>(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Trip[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [qrTrip, setQrTrip] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (trips.length > 0) scheduleAllTripReminders(trips).catch(() => {});
  }, [trips]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await tripsApi.search(searchQuery);
        setSearchResults(results);
      } catch { setSearchResults([]); } finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const displayedTrips = searchResults ?? trips;

  function openCreate() {
    haptics.tap();
    setSheetMode("create");
    setEditingTrip(null);
    setName("");
    setStartDate("");
    setEndDate("");
    setSheetVisible(true);
  }

  function openEdit(trip: Trip) {
    setSheetMode("edit");
    setEditingTrip(trip);
    setName(trip.name);
    setStartDate(trip.start_date ?? "");
    setEndDate(trip.end_date ?? "");
    setSheetVisible(true);
  }

  function closeSheet() {
    setSheetVisible(false);
    setName("");
    setStartDate("");
    setEndDate("");
    setStartDateError(null);
    setEndDateError(null);
    setEditingTrip(null);
  }

  function parsedDate(s: string): string | null {
    if (!s.trim()) return null;
    // Accept YYYY-MM-DD; pass through if valid, null otherwise
    return /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? s.trim() : null;
  }

  function handleStartDateChange(val: string) {
    setStartDate(val);
    if (val.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
      setStartDateError("Format: JJJJ-MM-TT (z.B. 2025-06-15)");
    } else {
      setStartDateError(null);
    }
  }

  function handleEndDateChange(val: string) {
    setEndDate(val);
    if (val.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) {
      setEndDateError("Format: JJJJ-MM-TT (z.B. 2025-06-15)");
    } else {
      setEndDateError(null);
    }
  }

  const hasDateError = startDateError !== null || endDateError !== null;

  async function save() {
    if (!name.trim()) return;
    if (hasDateError) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSaving(true);
    try {
      const start = parsedDate(startDate);
      const end = parsedDate(endDate);
      if (sheetMode === "create") {
        await createOffline({ name: name.trim(), description: null, start_date: start, end_date: end });
      } else if (editingTrip) {
        await updateOffline(editingTrip.id, { name: name.trim(), start_date: start, end_date: end });
      }
      await haptics.success();
      closeSheet();
    } catch (err) {
      await haptics.error();
      if (err instanceof ApiError && err.status === 402) {
        closeSheet();
        showToast("Trip-Limit erreicht – jetzt upgraden 🚀", "warning");
      } else {
        showToast("Trip konnte nicht erstellt werden", "error");
      }
    } finally {
      setSaving(false);
      submittingRef.current = false;
    }
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
      <UpgradeBanner />
      {error && <Text style={s.errorBanner}>Offline — zeige gespeicherte Daten</Text>}

      <TextInput
        style={searchInputStyle}
        placeholder="Trips durchsuchen..."
        placeholderTextColor="#3a3a5e"
        value={searchQuery}
        onChangeText={setSearchQuery}
        clearButtonMode="while-editing"
      />
      {searchQuery.trim() !== "" && searching && (
        <ActivityIndicator
          style={{ marginBottom: 8 }}
          color="#4f46e5"
          accessibilityLabel="Suche läuft"
        />
      )}

      <FlatList
        data={displayedTrips}
        keyExtractor={(t) => t.id}
        contentContainerStyle={[
          displayedTrips.length === 0 ? s.emptyContainer : s.list,
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
          <View>
            <TripCard
              trip={item}
              onPress={() => router.push(`/(app)/trips/${item.id}`)}
              onLongPress={() => openEdit(item)}
              score={tripScore(item.id, !!(item.start_date && item.end_date))}
            />
            <TouchableOpacity
              style={s.qrBtn}
              onPress={() => setQrTrip({ id: item.id, name: item.name })}
              accessibilityLabel={`QR-Code für ${item.name}`}
              accessibilityRole="button"
            >
              <Text style={s.qrBtnText}>⊞</Text>
            </TouchableOpacity>
          </View>
        )}
      />

      {qrTrip && (
        <TripQRModal
          tripId={qrTrip.id}
          tripName={qrTrip.name}
          visible={!!qrTrip}
          onClose={() => setQrTrip(null)}
        />
      )}

      <TouchableOpacity
        style={[s.fab, { bottom: insets.bottom + 24 }]}
        onPress={openCreate}
        activeOpacity={0.85}
        accessibilityLabel="Neuen Trip erstellen"
        accessibilityRole="button"
      >
        <Text style={s.fabText}>+</Text>
      </TouchableOpacity>

      <BottomSheet visible={sheetVisible} onClose={closeSheet} heightFraction={0.65} hasInputs>
        <View style={{ flex: 1 }}>
          <Text style={s.sheetTitle}>
            {sheetMode === "create" ? "Neuer Trip" : "Trip bearbeiten"}
          </Text>

          <Text style={s.fieldLabel}>Name *</Text>
          <TextInput
            style={s.input}
            placeholder="z.B. Barcelona Sommer 2025"
            placeholderTextColor="#6666aa"
            value={name}
            onChangeText={setName}
            autoFocus
            returnKeyType="next"
            accessibilityLabel="Trip-Name"
          />

          <Text style={s.fieldLabel}>Startdatum</Text>
          <TextInput
            style={s.input}
            placeholder="2025-06-15"
            placeholderTextColor="#6666aa"
            value={startDate}
            onChangeText={handleStartDateChange}
            keyboardType="numbers-and-punctuation"
            returnKeyType="next"
            accessibilityLabel="Startdatum"
          />
          {startDateError && (
            <Text style={{ color: "#ef4444", fontSize: 12 }}>{startDateError}</Text>
          )}

          <Text style={s.fieldLabel}>Enddatum</Text>
          <TextInput
            style={s.input}
            placeholder="2025-06-15"
            placeholderTextColor="#6666aa"
            value={endDate}
            onChangeText={handleEndDateChange}
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            onSubmitEditing={save}
            accessibilityLabel="Enddatum"
          />
          {endDateError && (
            <Text style={{ color: "#ef4444", fontSize: 12 }}>{endDateError}</Text>
          )}

          <View style={s.sheetButtons}>
            <TouchableOpacity
              style={s.cancelBtn}
              onPress={closeSheet}
              accessibilityLabel="Abbrechen"
              accessibilityRole="button"
            >
              <Text style={s.cancelText}>Abbrechen</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.saveBtn, (!name.trim() || saving || hasDateError) && s.saveBtnDisabled]}
              onPress={save}
              disabled={saving || !name.trim() || hasDateError}
              accessibilityLabel={sheetMode === "create" ? "Trip erstellen" : "Änderungen speichern"}
              accessibilityRole="button"
            >
              {saving
                ? <ActivityIndicator color="#fff" />
                : <Text style={s.saveText}>{sheetMode === "create" ? "Erstellen" : "Speichern"}</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </BottomSheet>
    </View>
  );
}

const searchInputStyle = {
  backgroundColor: "#1a1a2e",
  borderRadius: 12,
  paddingHorizontal: 16,
  paddingVertical: 12,
  color: "#fff",
  fontSize: 15,
  marginHorizontal: 16,
  marginBottom: 12,
  borderWidth: 1,
  borderColor: "#2a2a4a",
} as const;

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
  fieldLabel: { color: "#6666aa", fontSize: 12, fontWeight: "600", letterSpacing: 0.5, marginBottom: 6, marginTop: 4 },
  input: {
    backgroundColor: "#0f0f1a", borderRadius: 12, padding: 14,
    color: "#fff", fontSize: 16, borderWidth: 1, borderColor: "#2a2a4e", marginBottom: 10,
  },
  sheetButtons: { flexDirection: "row", gap: 12, justifyContent: "flex-end", marginTop: 8 },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10, borderWidth: 1, borderColor: "#2a2a4e" },
  cancelText: { color: "#8888aa", fontSize: 15 },
  saveBtn: { paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10, backgroundColor: "#4f46e5", minWidth: 100, alignItems: "center" },
  saveBtnDisabled: { opacity: 0.45 },
  saveText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  qrBtn: { position: "absolute", bottom: 10, right: 14, padding: 6 },
  qrBtnText: { color: "#4f46e5", fontSize: 16 },
});
