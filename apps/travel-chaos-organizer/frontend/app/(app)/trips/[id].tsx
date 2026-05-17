import { useEffect, useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, KeyboardAvoidingView,
  Platform, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useTripItems, useTrips } from "../../../hooks/useTrips";
import { parseFile, TripItem } from "../../../lib/api";
import SwipeableTimelineItem from "../../../components/SwipeableTimelineItem";
import TimelineItemDetail from "../../../components/TimelineItemDetail";
import ImportSheet from "../../../components/ImportSheet";
import FileUploadButton from "../../../components/FileUploadButton";
import { TimelineItemSkeleton } from "../../../components/Skeleton";
import { haptics } from "../../../lib/haptics";

export default function TripDetailScreen() {
  const { id, sharedUri, sharedMime, sharedName } = useLocalSearchParams<{
    id: string;
    sharedUri?: string;
    sharedMime?: string;
    sharedName?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { items, loading, refresh, deleteItem } = useTripItems(id);
  const { deleteTrip } = useTrips();
  const [parsing, setParsing] = useState(false);
  const [selectedItem, setSelectedItem] = useState<TripItem | null>(null);
  const [importVisible, setImportVisible] = useState(false);

  useEffect(() => {
    if (sharedUri) {
      parseAndRefresh(sharedUri, sharedMime ?? "application/octet-stream", sharedName ?? "shared-file");
    }
  }, [sharedUri]);

  async function uploadDocument() {
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*", "text/*"] });
    if (result.canceled) return;
    const asset = result.assets[0];
    await parseAndRefresh(asset.uri, asset.mimeType ?? "application/octet-stream", asset.name);
  }

  async function uploadScreenshot() {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9 });
    if (result.canceled) return;
    const asset = result.assets[0];
    await parseAndRefresh(asset.uri, "image/jpeg", "screenshot.jpg");
  }

  async function parseAndRefresh(uri: string, mime: string, name: string) {
    setParsing(true);
    await haptics.confirm();
    try {
      await parseFile(uri, mime, name, id);
      await haptics.success();
      await refresh();
    } catch {
      await haptics.error();
      Alert.alert("Fehler", "Datei konnte nicht verarbeitet werden. Prüfe die Verbindung und Ollama.");
    } finally {
      setParsing(false);
    }
  }

  async function handleDeleteItem(itemId: string) {
    Alert.alert("Eintrag löschen?", "Dieser Eintrag wird dauerhaft entfernt.", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Löschen", style: "destructive",
        onPress: async () => {
          await haptics.warning();
          await deleteItem(itemId);
        },
      },
    ]);
  }

  async function handleDeleteTrip() {
    Alert.alert("Trip löschen?", "Alle Einträge und Daten werden gelöscht.", [
      { text: "Abbrechen", style: "cancel" },
      {
        text: "Löschen", style: "destructive",
        onPress: async () => {
          await haptics.error();
          await deleteTrip(id);
          router.back();
        },
      },
    ]);
  }

  async function handleTapItem(item: TripItem) {
    await haptics.tap();
    setSelectedItem(item);
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={s.back}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Zurück"
          accessibilityRole="button"
        >
          <Text style={s.backText}>← Zurück</Text>
        </TouchableOpacity>

        <Text style={s.headerTitle}>Timeline</Text>

        <TouchableOpacity
          onPress={handleDeleteTrip}
          style={s.deleteBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Trip löschen"
          accessibilityRole="button"
        >
          <Text style={s.deleteBtnText}>🗑️</Text>
        </TouchableOpacity>
      </View>

      {parsing && (
        <View style={s.parsingBanner}>
          <ActivityIndicator color="#4f46e5" size="small" />
          <Text style={s.parsingText}>Ollama analysiert Dokument…</Text>
        </View>
      )}

      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={items.length === 0 ? s.emptyContainer : s.list}
        refreshing={loading}
        onRefresh={refresh}
        ListHeaderComponent={
          items.length > 0
            ? <Text style={s.hint}>Tippen für Details · ← Wischen zum Löschen</Text>
            : null
        }
        ListEmptyComponent={
          loading
            ? <View style={s.list}>{[1, 2, 3].map(k => <TimelineItemSkeleton key={k} />)}</View>
            : <View style={s.empty}>
                <Text style={s.emptyIcon}>📂</Text>
                <Text style={s.emptyTitle}>Noch keine Einträge</Text>
                <Text style={s.emptySub}>Lade ein Dokument hoch oder füge Text ein.</Text>
              </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => handleTapItem(item)}
            activeOpacity={0.85}
            accessibilityLabel={`${item.title} — Details anzeigen`}
            accessibilityRole="button"
          >
            <SwipeableTimelineItem
              item={item}
              onDelete={() => handleDeleteItem(item.id)}
            />
          </TouchableOpacity>
        )}
      />

      <View style={[s.uploadBar, { paddingBottom: insets.bottom + 8 }]}>
        <FileUploadButton icon="📄" label="PDF / Datei" onPress={uploadDocument} disabled={parsing} />
        <FileUploadButton icon="🖼️" label="Screenshot" onPress={uploadScreenshot} disabled={parsing} />
        <FileUploadButton
          icon="📝"
          label="Text einfügen"
          onPress={() => setImportVisible(true)}
          disabled={parsing}
        />
      </View>

      {/* Timeline item detail */}
      <TimelineItemDetail
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
      />

      {/* In-app text/email import */}
      <ImportSheet
        visible={importVisible}
        onClose={() => setImportVisible(false)}
        tripId={id}
        onSuccess={refresh}
      />
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  header: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: 16,
    paddingBottom: 12, backgroundColor: "#1a1a2e",
  },
  back: { paddingVertical: 4 },
  backText: { color: "#4f46e5", fontSize: 15 },
  headerTitle: { flex: 1, color: "#fff", fontSize: 18, fontWeight: "700", textAlign: "center" },
  deleteBtn: { padding: 4 },
  deleteBtnText: { fontSize: 18 },
  parsingBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#4f46e522", padding: 10, paddingHorizontal: 16 },
  parsingText: { color: "#a5b4fc", fontSize: 14 },
  hint: { color: "#3a3a5e", fontSize: 12, textAlign: "center", marginBottom: 8 },
  list: { padding: 16, gap: 1 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptySub: { fontSize: 14, color: "#6666aa", textAlign: "center" },
  uploadBar: {
    flexDirection: "row", gap: 8, padding: 12,
    backgroundColor: "#1a1a2e", borderTopWidth: 1, borderTopColor: "#2a2a4e",
  },
});
