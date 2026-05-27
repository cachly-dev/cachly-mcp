import { useRef, useState } from "react";
import {
  FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getLocalTrips, getLocalItems } from "../../lib/db";
import { TripItem } from "../../lib/api";
import TimelineItem from "../../components/TimelineItem";
import { haptics } from "../../lib/haptics";

type Result = TripItem & { trip_name: string };

export default function SearchScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onQueryChange(text: string) {
    setQuery(text);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (text.trim().length < 2) {
        setResults([]);
        return;
      }
      const q = text.toLowerCase();
      const trips = getLocalTrips();
      const matched: Result[] = [];

      for (const trip of trips) {
        const items = getLocalItems(trip.id);
        for (const item of items) {
          const searchable = [
            item.title,
            item.booking_ref,
            item.provider,
            item.raw_text,
            JSON.stringify(item.parsed_data),
          ].filter(Boolean).join(" ").toLowerCase();

          if (searchable.includes(q)) {
            matched.push({ ...item, trip_name: trip.name });
          }
        }
      }
      setResults(matched);
    }, 250);
  }

  const showResults = query.trim().length >= 2;

  return (
    <View style={[s.container, { paddingTop: insets.top > 0 ? 0 : 8 }]}>
      <View style={s.searchBar}>
        <Text style={s.searchIcon} accessibilityElementsHidden>🔍</Text>
        <TextInput
          style={s.input}
          placeholder="Buchungsref, Airline, Hotel…"
          placeholderTextColor="#4a4a7a"
          value={query}
          onChangeText={onQueryChange}
          autoFocus
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Suche"
          accessibilityHint="Mindestens 2 Zeichen eingeben"
        />
      </View>

      {showResults && results.length > 0 && (
        <Text style={s.resultCount}>{results.length} Ergebnis{results.length !== 1 ? "se" : ""}</Text>
      )}

      <FlatList
        data={results}
        keyExtractor={(i) => i.id}
        contentContainerStyle={results.length === 0 ? s.emptyContainer : s.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          showResults
            ? <View style={s.empty}><Text style={s.emptyText}>Keine Ergebnisse für „{query}"</Text></View>
            : <View style={s.empty}>
                <Text style={s.emptyHint}>Tippe mindestens 2 Zeichen{"\n"}um in deinen Trips zu suchen</Text>
              </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={async () => {
              await haptics.tap();
              router.push(`/(app)/trips/${item.trip_id}`);
            }}
            activeOpacity={0.75}
            accessibilityLabel={`${item.title} in Trip ${item.trip_name}`}
            accessibilityRole="button"
          >
            <View style={s.tripLabelRow}>
              <Text style={s.tripLabel}>🗺️  {item.trip_name}</Text>
            </View>
            <TimelineItem item={item} />
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  searchBar: {
    flexDirection: "row", alignItems: "center", gap: 10,
    margin: 16, marginBottom: 8,
    backgroundColor: "#1a1a2e", borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 2,
    borderWidth: 1, borderColor: "#2a2a4e",
  },
  searchIcon: { fontSize: 16 },
  input: { flex: 1, color: "#fff", fontSize: 16, paddingVertical: 12 },
  resultCount: { color: "#4f46e5", fontSize: 12, fontWeight: "600", paddingHorizontal: 20, marginBottom: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyText: { color: "#6666aa", fontSize: 15, textAlign: "center" },
  emptyHint: { color: "#3a3a5e", fontSize: 14, textAlign: "center", lineHeight: 22 },
  tripLabelRow: { flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 4, paddingHorizontal: 4 },
  tripLabel: { color: "#4f46e5", fontSize: 12, fontWeight: "600" },
});
