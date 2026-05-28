import React, { useEffect, useState } from "react";
import {
  ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView,
  Platform, Share, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import ConfettiCannon from "../../../components/ConfettiCannon";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import ConfirmDialog from "../../../components/ConfirmDialog";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useTripItems, useTrips } from "../../../hooks/useTrips";
import { ApiError, parseFile, TripItem } from "../../../lib/api";
import SwipeableTimelineItem from "../../../components/SwipeableTimelineItem";
import TimelineItemDetail from "../../../components/TimelineItemDetail";
import ImportSheet from "../../../components/ImportSheet";
import FileUploadButton from "../../../components/FileUploadButton";
import { TimelineItemSkeleton } from "../../../components/Skeleton";
import { haptics } from "../../../lib/haptics";
import { useToast } from "../../../components/ToastContext";
import { scheduleItemReminder } from "../../../lib/notifications";
import { getLocalItems } from "../../../lib/db";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";

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
  const { deleteTrip, trips } = useTrips();
  const { showToast } = useToast();
  const [parsing, setParsing] = useState(false);
  const [showConfetti, setShowConfetti] = useState(false);
  const [selectedItem, setSelectedItem] = useState<TripItem | null>(null);
  const [importVisible, setImportVisible] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message?: string; onConfirm: () => void; destructive?: boolean } | null>(null);

  useFocusEffect(
    React.useCallback(() => {
      const handler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (parsing) {
          setDialog({ title: 'Upload läuft', message: 'Ein Dokument wird gerade verarbeitet. Trotzdem zurück?', onConfirm: () => router.back(), destructive: true });
          return true;
        }
        return false;
      });
      return () => handler.remove();
    }, [parsing])
  );

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
    // Capture existing item IDs before upload so we can identify the new item
    // after refresh — and only schedule a reminder for that one item.
    // Without this, every upload would re-schedule reminders for ALL existing
    // items, causing duplicate (or spam) notifications.
    const itemIdsBefore = new Set(getLocalItems(id).map((i) => i.id));
    const currentTrip = trips.find((t) => t.id === id);
    const tripName = currentTrip?.name ?? "Dein Trip";
    try {
      await parseFile(uri, mime, name, id);
      await haptics.success();
      await refresh();
      // After refresh, SQLite is up-to-date. Find only the newly added item(s).
      const allItems = getLocalItems(id);
      for (const item of allItems) {
        if (!itemIdsBefore.has(item.id) && item.event_at) {
          await scheduleItemReminder(id, tripName, item.id, item.title, item.event_at);
        }
      }
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 1500);
    } catch (err) {
      await haptics.error();
      if (err instanceof ApiError && err.status === 429) {
        showToast("Tageslimit erreicht (50 Parses/Tag). Upgrade auf Pro.", "warning");
      } else if (err instanceof ApiError && err.status === 408) {
        showToast("Timeout — Ollama antwortet nicht. Bitte warte und versuche es erneut.", "error");
      } else if (err instanceof ApiError && err.status === 413) {
        showToast("Datei zu groß (max. 10 MB).", "error");
      } else if (err instanceof ApiError && err.status === 415) {
        showToast("Dateityp nicht unterstützt (PDF, Bild oder Text).", "error");
      } else {
        showToast("Datei konnte nicht verarbeitet werden. Prüfe Ollama.", "error");
      }
    } finally {
      setParsing(false);
    }
  }

  function handleDeleteItem(itemId: string) {
    setDialog({
      title: "Eintrag löschen?",
      message: "Dieser Eintrag wird dauerhaft entfernt.",
      destructive: true,
      onConfirm: async () => {
        await haptics.warning();
        await deleteItem(itemId);
      },
    });
  }

  function handleDeleteTrip() {
    setDialog({
      title: "Trip löschen?",
      message: "Alle Einträge und Daten werden gelöscht.",
      destructive: true,
      onConfirm: async () => {
        await haptics.error();
        await deleteTrip(id);
        router.back();
      },
    });
  }

  async function handleTapItem(item: TripItem) {
    await haptics.tap();
    setSelectedItem(item);
  }

  async function handleShareTrip() {
    const currentTrip = trips.find(t => t.id === id);
    const tripName = currentTrip?.name ?? "Mein Trip";
    const lines: string[] = [];

    lines.push(`✈️ Mein Trip: ${tripName}`);

    if (currentTrip?.start_date) {
      const startStr = format(parseISO(currentTrip.start_date), "dd. MMM", { locale: de });
      if (currentTrip.end_date) {
        const endStr = format(parseISO(currentTrip.end_date), "dd. MMM yyyy", { locale: de });
        const diffMs = new Date(currentTrip.end_date).getTime() - new Date(currentTrip.start_date).getTime();
        const days = Math.round(diffMs / (1000 * 60 * 60 * 24));
        lines.push(`📅 ${startStr} → ${endStr} (${days} Tage)`);
      } else {
        lines.push(`📅 ${startStr}`);
      }
    }

    if (items.length > 0) {
      const types = Array.from(new Set(items.map(i => i.type).filter(Boolean))) as string[];
      const capitalizedTypes = types.map(t => t.charAt(0).toUpperCase() + t.slice(1));
      const displayTypes = capitalizedTypes.length > 3
        ? `${capitalizedTypes.slice(0, 3).join(", ")} + mehr`
        : capitalizedTypes.join(", ");
      lines.push(`📋 ${items.length} Einträge${displayTypes ? ` (${displayTypes})` : ""}`);
    }

    const refs = items.map(i => i.booking_ref).filter(Boolean) as string[];
    if (refs.length > 0) {
      const displayRefs = refs.length > 3
        ? `${refs.slice(0, 3).join(", ")} + mehr`
        : refs.join(", ");
      lines.push(`🔑 ${displayRefs}`);
    }

    lines.push("");
    lines.push("Erstellt mit Travel Chaos Organizer");

    await Share.share({ message: lines.join("\n") });
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <View style={[s.header, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => {
            if (parsing) {
              setDialog({ title: 'Upload läuft', message: 'Ein Dokument wird gerade verarbeitet. Trotzdem zurück?', onConfirm: () => router.back(), destructive: true });
            } else {
              router.back();
            }
          }}
          style={s.back}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Zurück"
          accessibilityRole="button"
        >
          <Text style={s.backText}>← Zurück</Text>
        </TouchableOpacity>

        <Text style={s.headerTitle} numberOfLines={1}>
          {trips.find((t) => t.id === id)?.name ?? "Timeline"}
        </Text>

        <TouchableOpacity
          onPress={handleShareTrip}
          style={s.shareBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Trip teilen"
          accessibilityRole="button"
        >
          <Text style={s.shareBtnText}>↗</Text>
        </TouchableOpacity>

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
          label="Text / E-Mail"
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

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title ?? ""}
        message={dialog?.message}
        actions={[
          {
            label: dialog?.destructive ? "Ja, löschen" : "Ja, zurück",
            style: "destructive",
            onPress: () => { setDialog(null); dialog?.onConfirm(); },
          },
          { label: "Abbrechen", style: "cancel", onPress: () => setDialog(null) },
        ]}
      />

      <ConfettiCannon visible={showConfetti} />
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
  shareBtn: { padding: 4, marginRight: 8 },
  shareBtnText: { color: "#a5b4fc", fontSize: 20, fontWeight: "300" },
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
