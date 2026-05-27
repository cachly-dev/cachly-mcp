import { useEffect, useRef, useState } from "react";
import { Animated, AppState, AppStateStatus, StyleSheet, Text } from "react-native";
import * as Network from "expo-network";

export default function OfflineBadge() {
  const [offline, setOffline] = useState(false);
  const opacity = useState(new Animated.Value(0))[0];
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    let mounted = true;

    async function check() {
      const net = await Network.getNetworkStateAsync();
      if (!mounted) return;
      const isOffline = !net.isConnected;
      setOffline(isOffline);
      Animated.timing(opacity, {
        toValue: isOffline ? 1 : 0,
        duration: 300,
        useNativeDriver: true,
      }).start();
    }

    check();
    // Re-check when app returns to foreground, fall back to 30s interval
    const appStateSub = AppState.addEventListener("change", (next) => {
      if (appState.current.match(/inactive|background/) && next === "active") {
        check();
      }
      appState.current = next;
    });
    const interval = setInterval(check, 30_000);
    return () => { mounted = false; appStateSub.remove(); clearInterval(interval); };
  }, []);

  if (!offline) return null;

  return (
    <Animated.View style={[s.badge, { opacity }]}>
      <Text style={s.text}>⚡ Offline — gespeicherte Daten</Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  badge: {
    backgroundColor: "#7c3aed33",
    borderBottomWidth: 1,
    borderBottomColor: "#7c3aed55",
    paddingVertical: 6,
    alignItems: "center",
  },
  text: { color: "#c4b5fd", fontSize: 12, fontWeight: "500" },
});
