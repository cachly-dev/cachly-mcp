import { StyleSheet, Text, View } from "react-native";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";
import { TripItem } from "../lib/api";
import QRCodeViewer from "./QRCodeViewer";

const TYPE_ICONS: Record<string, string> = {
  flight: "✈️", train: "🚂", bus: "🚌", hotel: "🏨",
  rental_car: "🚗", activity: "🎡", transfer: "🚕", document: "📄", other: "📋",
};

const TYPE_COLORS: Record<string, string> = {
  flight: "#4f46e5", train: "#0891b2", bus: "#059669", hotel: "#d97706",
  rental_car: "#7c3aed", activity: "#db2777", transfer: "#6366f1", document: "#64748b", other: "#475569",
};

type Props = { item: TripItem };

export default function TimelineItem({ item }: Props) {
  const color = TYPE_COLORS[item.type] ?? TYPE_COLORS.other;
  const icon = TYPE_ICONS[item.type] ?? TYPE_ICONS.other;
  const parsed = item.parsed_data as Record<string, unknown> | null;

  return (
    <View style={s.row}>
      <View style={s.line}>
        <View style={[s.dot, { backgroundColor: color }]} />
        <View style={s.connector} />
      </View>

      <View style={s.card}>
        <View style={s.cardTop}>
          <Text style={s.icon}>{icon}</Text>
          <View style={s.cardMeta}>
            <Text style={s.title} numberOfLines={2}>{item.title}</Text>
            {item.event_at && (
              <Text style={s.time}>
                {format(parseISO(item.event_at), "EEE dd. MMM, HH:mm", { locale: de })}
              </Text>
            )}
          </View>
        </View>

        <View style={s.details}>
          {parsed?.origin && parsed?.destination && (
            <Text style={s.route}>{parsed.origin as string} → {parsed.destination as string}</Text>
          )}
          {item.provider && <Text style={s.chip}>{item.provider}</Text>}
          {item.booking_ref && (
            <QRCodeViewer bookingRef={item.booking_ref} title={item.title} />
          )}
          {parsed?.price && <Text style={s.chip}>{parsed.price as string}</Text>}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", gap: 12, paddingBottom: 2 },
  line: { alignItems: "center", width: 24 },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 18 },
  connector: { flex: 1, width: 2, backgroundColor: "#2a2a4e", marginTop: 2 },
  card: { flex: 1, backgroundColor: "#1a1a2e", borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#2a2a4e", gap: 8 },
  cardTop: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  icon: { fontSize: 22, marginTop: 2 },
  cardMeta: { flex: 1, gap: 2 },
  title: { color: "#fff", fontSize: 15, fontWeight: "600", lineHeight: 20 },
  time: { color: "#6666aa", fontSize: 12 },
  details: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  route: { color: "#a5b4fc", fontSize: 13, width: "100%" },
  chip: { backgroundColor: "#0f0f1a", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, color: "#8888aa", fontSize: 12 },
});
