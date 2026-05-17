/**
 * Skeleton loader — animated shimmer placeholder while data loads.
 * Mirrors the shape of TripCard and TimelineItem so there's no layout jump.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

function ShimmerBar({ width, height = 14, style }: { width: number | `${number}%`; height?: number; style?: object }) {
  const anim = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0.3, duration: 900, useNativeDriver: true }),
      ])
    ).start();
  }, []);

  return (
    <Animated.View
      style={[{ width, height, borderRadius: 6, backgroundColor: "#2a2a4e", opacity: anim }, style]}
    />
  );
}

export function TripCardSkeleton() {
  return (
    <View style={s.card}>
      <View style={s.row}>
        <View style={{ flex: 1, gap: 8 }}>
          <ShimmerBar width="70%" height={16} />
          <ShimmerBar width="45%" height={12} />
        </View>
        <ShimmerBar width={52} height={22} style={{ borderRadius: 6 }} />
      </View>
    </View>
  );
}

export function TimelineItemSkeleton() {
  return (
    <View style={s.timelineRow}>
      <View style={s.line}>
        <ShimmerBar width={12} height={12} style={{ borderRadius: 6 }} />
      </View>
      <View style={s.timelineCard}>
        <View style={s.row}>
          <ShimmerBar width={28} height={28} style={{ borderRadius: 6 }} />
          <View style={{ flex: 1, gap: 6 }}>
            <ShimmerBar width="65%" height={14} />
            <ShimmerBar width="40%" height={11} />
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          <ShimmerBar width={80} height={22} />
          <ShimmerBar width={70} height={22} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 18, borderWidth: 1, borderColor: "#2a2a4e", gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  timelineRow: { flexDirection: "row", gap: 12, paddingBottom: 2 },
  line: { alignItems: "center", width: 24, paddingTop: 18 },
  timelineCard: { flex: 1, backgroundColor: "#1a1a2e", borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: "#2a2a4e", gap: 10 },
});
