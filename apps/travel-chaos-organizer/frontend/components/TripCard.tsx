import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { format, parseISO, differenceInDays } from "date-fns";
import { de } from "date-fns/locale";
import { Trip } from "../lib/api";
import { haptics } from "../lib/haptics";

type Props = {
  trip: Trip;
  onPress: () => void;
  onLongPress?: () => void;
};

export default function TripCard({ trip, onPress, onLongPress }: Props) {
  const start = trip.start_date ? parseISO(trip.start_date) : null;
  const end = trip.end_date ? parseISO(trip.end_date) : null;
  const duration = start && end ? differenceInDays(end, start) : null;
  const isUpcoming = start && start > new Date();
  const isPast = end && end < new Date();

  async function handleLongPress() {
    if (onLongPress) {
      await haptics.confirm();
      onLongPress();
    }
  }

  return (
    <TouchableOpacity
      style={s.card}
      onPress={onPress}
      onLongPress={handleLongPress}
      activeOpacity={0.8}
      accessibilityLabel={`Trip: ${trip.name}`}
      accessibilityRole="button"
      accessibilityHint={onLongPress ? "Gedrückt halten zum Bearbeiten" : undefined}
    >
      <View style={s.row}>
        <View style={s.info}>
          <Text style={s.name} numberOfLines={1}>{trip.name}</Text>
          {start && (
            <Text style={s.dates}>
              {format(start, "dd. MMM", { locale: de })}
              {end ? ` → ${format(end, "dd. MMM yyyy", { locale: de })}` : ""}
              {duration !== null ? `  ·  ${duration} Tage` : ""}
            </Text>
          )}
          {!start && <Text style={s.dates}>Kein Datum gesetzt</Text>}
        </View>
        <View style={[s.badge, isUpcoming && s.badgeUpcoming, isPast && s.badgePast]}>
          <Text style={s.badgeText}>{isUpcoming ? "Geplant" : isPast ? "Vorbei" : "Aktuell"}</Text>
        </View>
      </View>
      {trip.description && <Text style={s.desc} numberOfLines={1}>{trip.description}</Text>}
      {onLongPress && <Text style={s.editHint}>Gedrückt halten zum Bearbeiten</Text>}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 18, borderWidth: 1, borderColor: "#2a2a4e", gap: 6 },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  info: { flex: 1, gap: 4 },
  name: { color: "#fff", fontSize: 17, fontWeight: "700" },
  dates: { color: "#6666aa", fontSize: 13 },
  desc: { color: "#8888aa", fontSize: 13 },
  badge: { backgroundColor: "#2a2a4e", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeUpcoming: { backgroundColor: "#4f46e522", borderWidth: 1, borderColor: "#4f46e5" },
  badgePast: { backgroundColor: "#1a1a1a" },
  badgeText: { color: "#a5b4fc", fontSize: 12, fontWeight: "500" },
  editHint: { color: "#3a3a5e", fontSize: 11 },
});
