/**
 * Full-detail bottom sheet for a timeline item.
 * Shows all parsed fields: route, passengers, price, raw_summary, booking_ref.
 */
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { format, parseISO } from "date-fns";
import { de } from "date-fns/locale";
import BottomSheet from "./BottomSheet";
import QRCodeViewer from "./QRCodeViewer";
import { TripItem } from "../lib/api";

const TYPE_LABELS: Record<string, string> = {
  flight: "Flug", train: "Zug", bus: "Bus", hotel: "Hotel",
  rental_car: "Mietwagen", activity: "Aktivität", transfer: "Transfer",
  document: "Dokument", other: "Sonstiges",
};

type Props = {
  item: TripItem | null;
  onClose: () => void;
};

export default function TimelineItemDetail({ item, onClose }: Props) {
  if (!item) return null;
  const parsed = item.parsed_data as Record<string, unknown> | null;

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return "—";
    try {
      return format(parseISO(iso), "EEE dd. MMM yyyy, HH:mm", { locale: de });
    } catch {
      return iso;
    }
  }

  return (
    <BottomSheet visible={!!item} onClose={onClose} heightFraction={0.75}>
      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {/* Header */}
        <View style={s.header}>
          <View style={s.typePill}>
            <Text style={s.typeText}>{TYPE_LABELS[item.type] ?? item.type}</Text>
          </View>
          {item.provider && <Text style={s.provider}>{item.provider}</Text>}
        </View>

        <Text style={s.title}>{item.title}</Text>

        {/* Core details */}
        <View style={s.section}>
          {item.event_at && <DetailRow label="Abflug / Check-in" value={fmtDate(item.event_at)} />}
          {item.event_end_at && <DetailRow label="Ankunft / Check-out" value={fmtDate(item.event_end_at)} />}
          {parsed?.origin && parsed?.destination && (
            <DetailRow label="Route" value={`${parsed.origin} → ${parsed.destination}`} />
          )}
          {item.booking_ref && <DetailRow label="Buchungsnr." value={item.booking_ref} mono />}
          {parsed?.confirmation_number && (
            <DetailRow label="Bestätigungsnr." value={parsed.confirmation_number as string} mono />
          )}
          {parsed?.price && <DetailRow label="Preis" value={parsed.price as string} />}
          {parsed?.passengers && Array.isArray(parsed.passengers) && parsed.passengers.length > 0 && (
            <DetailRow label="Passagiere" value={(parsed.passengers as string[]).join(", ")} />
          )}
        </View>

        {/* Summary */}
        {parsed?.raw_summary && (
          <View style={s.summaryBox}>
            <Text style={s.summaryLabel}>Zusammenfassung</Text>
            <Text style={s.summaryText}>{parsed.raw_summary as string}</Text>
          </View>
        )}

        {/* QR code */}
        {item.booking_ref && (
          <View style={s.qrRow}>
            <QRCodeViewer bookingRef={item.booking_ref} title={item.title} />
          </View>
        )}

        {/* Confidence */}
        {typeof parsed?.confidence === "number" && (
          <Text style={s.confidence}>
            KI-Konfidenz: {Math.round((parsed.confidence as number) * 100)}%
          </Text>
        )}
      </ScrollView>
    </BottomSheet>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, mono && s.mono]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  typePill: { backgroundColor: "#4f46e522", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: "#4f46e544" },
  typeText: { color: "#a5b4fc", fontSize: 12, fontWeight: "600" },
  provider: { color: "#6666aa", fontSize: 13 },
  title: { fontSize: 18, fontWeight: "700", color: "#fff", marginBottom: 16, lineHeight: 24 },
  section: { backgroundColor: "#0f0f1a", borderRadius: 12, padding: 4, marginBottom: 14, borderWidth: 1, borderColor: "#2a2a4e" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", paddingVertical: 10, paddingHorizontal: 12, gap: 12 },
  rowLabel: { color: "#6666aa", fontSize: 13, flex: 1 },
  rowValue: { color: "#e2e8f0", fontSize: 13, flex: 2, textAlign: "right" },
  mono: { fontFamily: "monospace", color: "#a5b4fc" },
  summaryBox: { backgroundColor: "#1a1a2e", borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: "#2a2a4e" },
  summaryLabel: { color: "#6666aa", fontSize: 11, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 6 },
  summaryText: { color: "#c4b5fd", fontSize: 13, lineHeight: 20 },
  qrRow: { alignItems: "flex-start", marginBottom: 14 },
  confidence: { color: "#3a3a5e", fontSize: 11, textAlign: "right", marginBottom: 8 },
});
