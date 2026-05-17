import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

type Action = {
  label: string;
  style?: "default" | "cancel" | "destructive";
  onPress?: () => void;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  actions: Action[];
};

export default function ConfirmDialog({ visible, title, message, actions }: Props) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 280 }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 140, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.92, duration: 140, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  if (!visible) return null;

  return (
    <View style={s.overlay} pointerEvents="box-none">
      <Pressable style={StyleSheet.absoluteFill} />
      <Animated.View style={[s.backdrop, { opacity }]} />
      <Animated.View style={[s.card, { opacity, transform: [{ scale }] }]}>
        <Text style={s.title}>{title}</Text>
        {message ? <Text style={s.message}>{message}</Text> : null}
        <View style={s.actions}>
          {actions.map((a, i) => (
            <TouchableOpacity
              key={i}
              style={[
                s.btn,
                a.style === "destructive" && s.btnDestructive,
                a.style === "cancel" && s.btnCancel,
              ]}
              onPress={a.onPress}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={a.label}
            >
              <Text
                style={[
                  s.btnText,
                  a.style === "destructive" && s.btnTextDestructive,
                  a.style === "cancel" && s.btnTextCancel,
                ]}
              >
                {a.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000000bb",
  },
  card: {
    backgroundColor: "#1a1a2e",
    borderRadius: 20,
    padding: 24,
    width: 300,
    borderWidth: 1,
    borderColor: "#2a2a4a",
    gap: 8,
  },
  title: { color: "#fff", fontSize: 17, fontWeight: "700" },
  message: { color: "#9999cc", fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: "column", gap: 8, marginTop: 8 },
  btn: {
    backgroundColor: "#4f46e5",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
  },
  btnCancel: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#2a2a4a" },
  btnDestructive: { backgroundColor: "#7f1d1d" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  btnTextCancel: { color: "#9999cc" },
  btnTextDestructive: { color: "#fca5a5" },
});
