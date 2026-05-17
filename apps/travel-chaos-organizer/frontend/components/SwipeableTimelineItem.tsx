/**
 * Timeline item with swipe-left-to-delete gesture.
 * Mirrors SwipeableInboxItem pattern for consistent UX.
 */
import { useRef } from "react";
import { Animated, PanResponder, StyleSheet, Text, View } from "react-native";
import { TripItem } from "../lib/api";
import TimelineItem from "./TimelineItem";
import { haptics } from "../lib/haptics";

const SWIPE_THRESHOLD = 80;
const ACTION_WIDTH = 72;

type Props = {
  item: TripItem;
  onDelete: () => void;
};

export default function SwipeableTimelineItem({ item, onDelete }: Props) {
  const translateX = useRef(new Animated.Value(0)).current;

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dy) < 20,
      onPanResponderMove: (_, g) => {
        // Only allow swipe left (negative dx)
        const clamped = Math.min(0, Math.max(-ACTION_WIDTH * 1.5, g.dx));
        translateX.setValue(clamped);
      },
      onPanResponderRelease: async (_, g) => {
        if (g.dx < -SWIPE_THRESHOLD) {
          await haptics.warning();
          snapBack();
          onDelete();
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
      {/* Right action — delete (revealed by swipe left) */}
      <View style={s.deleteAction}>
        <Text style={s.deleteIcon}>🗑️</Text>
        <Text style={s.deleteLabel}>Löschen</Text>
      </View>

      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        <TimelineItem item={item} />
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: { position: "relative" },
  deleteAction: {
    position: "absolute", top: 0, bottom: 8, right: 0,
    width: ACTION_WIDTH, alignItems: "center", justifyContent: "center",
    backgroundColor: "#dc262633", borderRadius: 14, gap: 4,
  },
  deleteIcon: { fontSize: 20 },
  deleteLabel: { color: "#fff", fontSize: 11, fontWeight: "600" },
});
