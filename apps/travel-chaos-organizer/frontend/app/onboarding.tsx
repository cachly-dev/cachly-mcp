import { useRef, useState } from "react";
import {
  Animated, Dimensions, FlatList, StyleSheet, Text,
  TouchableOpacity, View,
} from "react-native";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { haptics } from "../lib/haptics";

const { width } = Dimensions.get("window");
const ONBOARDING_KEY = "tco_onboarding_done";

const SLIDES = [
  {
    icon: "✈️",
    title: "Reisechaos ade",
    body: "Alle Buchungen, Tickets und Dokumente an einem Ort — automatisch sortiert.",
  },
  {
    icon: "📸",
    title: "Einfach scannen",
    body: "Screenshot machen, PDF teilen oder E-Mail einfügen. KI erkennt alle Details automatisch.",
  },
  {
    icon: "📶",
    title: "Offline verfügbar",
    body: "Deine Tickets und QR-Codes sind auch ohne Internet abrufbar — am Gate, im Zug, überall.",
  },
  {
    icon: "🔐",
    title: "Deine Daten, dein Server",
    body: "Alles läuft auf deiner eigenen Infrastruktur. Keine Cloud, kein Tracking.",
  },
];

export async function isOnboardingDone(): Promise<boolean> {
  return (await AsyncStorage.getItem(ONBOARDING_KEY)) === "done";
}

export default function OnboardingScreen() {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const scrollX = useRef(new Animated.Value(0)).current;
  const listRef = useRef<FlatList>(null);

  async function next() {
    await haptics.tap();
    if (index < SLIDES.length - 1) {
      listRef.current?.scrollToIndex({ index: index + 1, animated: true });
      setIndex(index + 1);
    } else {
      await finish();
    }
  }

  async function finish() {
    await AsyncStorage.setItem(ONBOARDING_KEY, "done");
    await haptics.success();
    router.replace("/(auth)/login");
  }

  return (
    <View style={s.container}>
      <TouchableOpacity style={s.skip} onPress={finish}>
        <Text style={s.skipText}>Überspringen</Text>
      </TouchableOpacity>

      <Animated.FlatList
        ref={listRef}
        data={SLIDES}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEnabled={false}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: false })}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item }) => (
          <View style={[s.slide, { width }]}>
            <Text style={s.icon}>{item.icon}</Text>
            <Text style={s.title}>{item.title}</Text>
            <Text style={s.body}>{item.body}</Text>
          </View>
        )}
      />

      <View style={s.footer}>
        <View style={s.dots}>
          {SLIDES.map((_, i) => {
            const inputRange = [(i - 1) * width, i * width, (i + 1) * width];
            const dotWidth = scrollX.interpolate({ inputRange, outputRange: [8, 24, 8], extrapolate: "clamp" });
            const opacity = scrollX.interpolate({ inputRange, outputRange: [0.3, 1, 0.3], extrapolate: "clamp" });
            return <Animated.View key={i} style={[s.dot, { width: dotWidth, opacity }]} />;
          })}
        </View>

        <TouchableOpacity style={s.button} onPress={next}>
          <Text style={s.buttonText}>
            {index < SLIDES.length - 1 ? "Weiter" : "Los geht's"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
  skip: { position: "absolute", top: 56, right: 24, zIndex: 10 },
  skipText: { color: "#4a4a7a", fontSize: 14 },
  slide: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40, gap: 24 },
  icon: { fontSize: 88 },
  title: { fontSize: 30, fontWeight: "800", color: "#fff", textAlign: "center", lineHeight: 36 },
  body: { fontSize: 16, color: "#8888aa", textAlign: "center", lineHeight: 24, maxWidth: 300 },
  footer: { padding: 32, gap: 24, alignItems: "center" },
  dots: { flexDirection: "row", gap: 6, alignItems: "center" },
  dot: { height: 8, borderRadius: 4, backgroundColor: "#4f46e5" },
  button: { backgroundColor: "#4f46e5", paddingVertical: 16, borderRadius: 14, width: "100%", alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
});
