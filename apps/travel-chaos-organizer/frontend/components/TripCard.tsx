import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { format, parseISO, differenceInDays } from "date-fns";
import { de } from "date-fns/locale";
import { Trip } from "../lib/api";
import { haptics } from "../lib/haptics";
import ScoreRing from "./ScoreRing";

type Props = {
  trip: Trip;
  onPress: () => void;
  onLongPress?: () => void;
  score?: number;
};

export default function TripCard({ trip, onPress, onLongPress, score }: Props) {
  const start = trip.start_date ? parseISO(trip.start_date) : null;
  const end = trip.end_date ? parseISO(trip.end_date) : null;
  const duration = start && end ? differenceInDays(end, start) : null;
  const today = new Date();
  const isActive = start && end && start <= today && today <= end;
  const daysUntil = start && start > today ? differenceInDays(start, today) : null;
  const isUpcoming = start && start > today;
  const isPast = end && end < today;

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (isActive) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.4, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [isActive]);

  async function handleLongPress() {
    if (onLongPress) {
      await haptics.confirm();
      onLongPress();
    }
  }

  function getBadgeText(): string {
    if (isActive) return "✈️ Jetzt auf Reise";
    if (daysUntil !== null) {
      if (daysUntil === 0) return "🚀 Heute!";
      if (daysUntil === 1) return "✈️ Morgen!";
      if (daysUntil <= 7) return `✈️ in ${daysUntil} Tagen`;
      if (daysUntil <= 30) return `🗓️ in ${daysUntil} Tagen`;
    }
    if (isUpcoming) return "Geplant";
    if (isPast) return "Vorbei";
    return "Aktuell";
  }

  const badgeText = getBadgeText();
  const isCloseCountdown = daysUntil !== null && daysUntil <= 7;

  return (
    <TouchableOpacity
      style={[s.card, isActive && s.cardActive]}
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
        <View style={s.badgeRow}>
          {isActive && (
            <Animated.View style={[s.pulseDot, { opacity: pulseAnim }]} />
          )}
          <View style={[
            s.badge,
            isActive && s.badgeActive,
            isUpcoming && !isActive && s.badgeUpcoming,
            isPast && s.badgePast,
          ]}>
            <Text style={[
              s.badgeText,
              isActive && s.badgeTextActive,
              isCloseCountdown && s.badgeTextCountdown,
            ]}>
              {badgeText}
            </Text>
          </View>
        </View>
      </View>
      <View style={s.footer}>
        <View style={s.footerLeft}>
          {trip.description
            ? <Text style={s.desc} numberOfLines={1}>{trip.description}</Text>
            : null}
          {onLongPress && <Text style={s.editHint}>Gedrückt halten zum Bearbeiten</Text>}
        </View>
        {score !== undefined && (
          <View style={s.scoreWrap}>
            <ScoreRing score={score} size={38} />
            {score === 100 && <Text style={s.scoreComplete}>✓</Text>}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 18, borderWidth: 1, borderColor: "#2a2a4e", gap: 6 },
  cardActive: { borderLeftWidth: 4, borderLeftColor: "#4f46e5" },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  info: { flex: 1, gap: 4 },
  name: { color: "#fff", fontSize: 17, fontWeight: "700" },
  dates: { color: "#6666aa", fontSize: 13 },
  desc: { color: "#8888aa", fontSize: 13 },
  badgeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  pulseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#a5b4fc" },
  badge: { backgroundColor: "#2a2a4e", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeActive: { backgroundColor: "#4f46e5" },
  badgeUpcoming: { backgroundColor: "#4f46e522", borderWidth: 1, borderColor: "#4f46e5" },
  badgePast: { backgroundColor: "#1a1a1a" },
  badgeText: { color: "#a5b4fc", fontSize: 12, fontWeight: "500" },
  badgeTextActive: { color: "#fff" },
  badgeTextCountdown: { color: "#a5b4fc", fontWeight: "700" },
  editHint: { color: "#3a3a5e", fontSize: 11 },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  footerLeft: { flex: 1, gap: 2 },
  scoreWrap: { alignItems: "center", justifyContent: "center" },
  scoreComplete: { position: "absolute", color: "#10b981", fontSize: 14, fontWeight: "800" },
});
