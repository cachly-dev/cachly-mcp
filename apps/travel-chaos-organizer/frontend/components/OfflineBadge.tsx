import { useEffect, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import * as Network from "expo-network";

export default function OfflineBadge() {
  const [offline, setOffline] = useState(false);
  const opacity = useState(new Animated.Value(0))[0];

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
    const interval = setInterval(check, 5000);
    return () => { mounted = false; clearInterval(interval); };
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
