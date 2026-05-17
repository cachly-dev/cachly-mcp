import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ToastItem } from "./ToastContext";

// exported so ToastContext can import the type
export type { ToastItem };

const ICONS = { success: "✓", error: "✗", warning: "⚠", info: "ℹ" };
const COLORS = {
  success: { border: "#34d399", bg: "#34d39915", text: "#34d399" },
  error:   { border: "#f87171", bg: "#f8717115", text: "#f87171" },
  warning: { border: "#fbbf24", bg: "#fbbf2415", text: "#fbbf24" },
  info:    { border: "#60a5fa", bg: "#60a5fa15", text: "#60a5fa" },
};

function SingleToast({ toast, onDone }: { toast: ToastItem; onDone: (id: string) => void }) {
  const translateY = useRef(new Animated.Value(-72)).current;
  const opacity    = useRef(new Animated.Value(0)).current;
  const c = COLORS[toast.type];

  useEffect(() => {
    Animated.parallel([
      Animated.spring(translateY, { toValue: 0, useNativeDriver: true, damping: 20, stiffness: 220 }),
      Animated.timing(opacity,    { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(translateY, { toValue: -72, duration: 220, useNativeDriver: true }),
        Animated.timing(opacity,    { toValue: 0,   duration: 200, useNativeDriver: true }),
      ]).start(() => onDone(toast.id));
    }, toast.duration ?? 3500);

    return () => clearTimeout(timer);
  }, []);

  return (
    <Animated.View style={[s.toast, { borderColor: c.border, backgroundColor: c.bg, opacity, transform: [{ translateY }] }]}>
      <Text style={[s.icon, { color: c.text }]}>{ICONS[toast.type]}</Text>
      <Text style={[s.msg, { color: c.text }]} numberOfLines={3}>{toast.message}</Text>
    </Animated.View>
  );
}

export default function ToastRenderer({ toasts, remove }: { toasts: ToastItem[]; remove: (id: string) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[s.container, { top: insets.top + 12 }]} pointerEvents="none">
      {toasts.slice(0, 3).map(t => <SingleToast key={t.id} toast={t} onDone={remove} />)}
    </View>
  );
}

const s = StyleSheet.create({
  container: { position: "absolute", left: 16, right: 16, zIndex: 9999, gap: 8 },
  toast: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 12, borderWidth: 1 },
  icon: { fontSize: 16, fontWeight: "700", flexShrink: 0 },
  msg:  { fontSize: 14, flex: 1, fontWeight: "500", lineHeight: 19 },
});
