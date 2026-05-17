import { useState } from "react";
import {
  ActivityIndicator, Alert, FlatList, StyleSheet,
  Text, TouchableOpacity, View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useTripItems } from "../../../hooks/useTrips";
import { parseFile } from "../../../lib/api";
import TimelineItem from "../../../components/TimelineItem";
import FileUploadButton from "../../../components/FileUploadButton";
import { TimelineItemSkeleton } from "../../../components/Skeleton";
import { haptics } from "../../../lib/haptics";

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { items, loading, refresh } = useTripItems(id);
  const [parsing, setParsing] = useState(false);

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

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.back}>
          <Text style={s.backText}>← Zurück</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Timeline</Text>
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
        ListEmptyComponent={
          loading
            ? <View style={s.list}>{[1,2,3].map(k => <TimelineItemSkeleton key={k} />)}</View>
            : <View style={s.empty}>
                <Text style={s.emptyIcon}>📂</Text>
                <Text style={s.emptyTitle}>Noch keine Einträge</Text>
                <Text style={s.emptySub}>Wirf Tickets, Buchungen oder Screenshots rein.</Text>
              </View>
        }
        renderItem={({ item }) => <TimelineItem item={item} />}
      />

      <View style={s.uploadBar}>
        <FileUploadButton icon="📄" label="PDF / Datei" onPress={uploadDocument} disabled={parsing} />
        <FileUploadButton icon="🖼️" label="Screenshot" onPress={uploadScreenshot} disabled={parsing} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  header: { flexDirection: "row", alignItems: "center", padding: 16, backgroundColor: "#1a1a2e", gap: 12 },
  back: { paddingVertical: 4 },
  backText: { color: "#4f46e5", fontSize: 15 },
  headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  parsingBanner: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#4f46e522", padding: 10, paddingHorizontal: 16 },
  parsingText: { color: "#a5b4fc", fontSize: 14 },
  list: { padding: 16, gap: 1 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: "700", color: "#fff", marginBottom: 8 },
  emptySub: { fontSize: 14, color: "#6666aa", textAlign: "center" },
  uploadBar: { flexDirection: "row", gap: 12, padding: 16, backgroundColor: "#1a1a2e", borderTopWidth: 1, borderTopColor: "#2a2a4e" },
});
