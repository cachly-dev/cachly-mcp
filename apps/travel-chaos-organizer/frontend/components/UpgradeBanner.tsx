import React from "react";
import { StyleSheet, Text, TouchableOpacity, View, Linking } from "react-native";
import { useQuota } from "../lib/quota";

export function UpgradeBanner() {
  const { plan, isPro } = useQuota();
  if (isPro || !plan) return null;

  return (
    <View style={s.banner}>
      <Text style={s.text}>
        Free Plan · {plan.free_daily_parses} Parses/Tag · {plan.free_max_trips} Trips
      </Text>
      <TouchableOpacity
        style={s.btn}
        onPress={() => Linking.openURL(process.env.EXPO_PUBLIC_UPGRADE_URL ?? "https://tco.app/upgrade")}
        activeOpacity={0.8}
      >
        <Text style={s.btnText}>Pro ✦</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1a1a2e",
    borderBottomWidth: 1,
    borderBottomColor: "#2a2a4a",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: { color: "#6666aa", fontSize: 12 },
  btn: {
    backgroundColor: "#4f46e5",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
  btnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
