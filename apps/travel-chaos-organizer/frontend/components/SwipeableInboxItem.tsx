/**
 * Swipeable inbox row — swipe left to reject, swipe right to assign.
 * Uses Animated + PanResponder (no extra library needed).
 * Minimum touch target: 48pt (Apple HIG / Material spec).
 */
import { useRef } from "react";
import {
  Animated, PanResponder, StyleSheet, Text, TouchableOpacity, View,
} from "react-native";
import { InboxItem } from "../lib/api";
import { haptics } from "../lib/haptics";

const SWIPE_THRESHOLD = 80;
const ACTION_WIDTH = 72;

type Props = {
  item: InboxItem;
  onAssign: () => void;
  onReject: () => void;
};

export default function SwipeableInboxItem({ item, onAssign, onReject }: Props) {
  const translateX = useRef(new Animated.Value(0)).current;
  const parsed = item.parsed_data as Record<string, unknown> | null;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        translateX.setValue(Math.max(-ACTION_WIDTH * 1.5, Math.min(ACTION_WIDTH * 1.5, g.dx)));
      },
      onPanResponderRelease: async (_, g) => {
        if (g.dx > SWIPE_THRESHOLD) {
          await haptics.confirm();
          snapBack();
          onAssign();
        } else if (g.dx < -SWIPE_THRESHOLD) {
          await haptics.warning();
          snapBack();
          onReject();
        } else {
          snapBack();
        }
      },
    })
  ).current;

  function snapBack() {
    Animated.spring(translateX, { toValue: 0, useNativeDriver: true, damping: 15 }).start();
  }

  return (
    <View style={s.wrapper}>
      {/* Left action — assign (revealed by swipe right) */}
      <View style={[s.action, s.actionAssign]}>
        <Text style={s.actionIcon}>✅</Text>
        <Text style={s.actionLabel}>Zuweisen</Text>
      </View>

      {/* Right action — reject (revealed by swipe left) */}
      <View style={[s.action, s.actionReject]}>
        <Text style={s.actionIcon}>🗑️</Text>
        <Text style={s.actionLabel}>Ablehnen</Text>
      </View>

      {/* Card row */}
      <Animated.View style={[s.card, { transform: [{ translateX }] }]} {...panResponder.panHandlers}>
        <View style={s.typeCol}>
          <Text style={s.typeIcon}>{typeIcon(parsed?.type as string)}</Text>
        </View>

        <View style={s.content}>
          <Text style={s.title} numberOfLines={1}>
            {(parsed?.title as string) ?? "Unbekanntes Dokument"}
          </Text>
          <Text style={s.sub} numberOfLines={1}>
            {(parsed?.provider as string) ?? (item.source ?? "Unbekannte Quelle")}
            {parsed?.booking_ref ? `  ·  #${parsed.booking_ref}` : ""}
          </Text>
          {!!parsed?.raw_summary && (
            <Text style={s.summary} numberOfLines={2}>{parsed.raw_summary as string}</Text>
          )}
        </View>

        {/* Explicit buttons as fallback for non-swipe users */}
        <View style={s.actions}>
          <TouchableOpacity style={s.btn} onPress={onAssign} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} accessibilityLabel="Zuweisen" accessibilityRole="button">
            <Text style={s.btnText}>→</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btn, s.btnDanger]} onPress={onReject} hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }} accessibilityLabel="Ablehnen" accessibilityRole="button">
            <Text style={s.btnText}>✕</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
}

function typeIcon(type?: string): string {
  return ({ flight: "✈️", train: "🚂", bus: "🚌", hotel: "🏨", rental_car: "🚗", activity: "🎡", transfer: "🚕", document: "📄" } as Record<string, string>)[type ?? ""] ?? "📋";
}

const s = StyleSheet.create({
  wrapper: { position: "relative", marginBottom: 10 },
  action: { position: "absolute", top: 0, bottom: 0, width: ACTION_WIDTH, alignItems: "center", justifyContent: "center", borderRadius: 16, gap: 4 },
  actionAssign: { left: 0, backgroundColor: "#16a34a33" },
  actionReject: { right: 0, backgroundColor: "#dc262633" },
  actionIcon: { fontSize: 22 },
  actionLabel: { color: "#fff", fontSize: 11, fontWeight: "600" },
  card: { backgroundColor: "#1a1a2e", borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: "#2a2a4e", minHeight: 72 },
  typeCol: { width: 36, alignItems: "center" },
  typeIcon: { fontSize: 26 },
  content: { flex: 1, gap: 3 },
  title: { color: "#fff", fontSize: 15, fontWeight: "600" },
  sub: { color: "#6666aa", fontSize: 12 },
  summary: { color: "#8888aa", fontSize: 12, lineHeight: 17, marginTop: 2 },
  actions: { gap: 6 },
  btn: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#2a2a4e", alignItems: "center", justifyContent: "center" },
  btnDanger: { backgroundColor: "#3a1a1a" },
  btnText: { color: "#fff", fontSize: 16 },
});
