import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

// This screen is the OAuth callback target.
// When Keycloak redirects to exp://u.expo.dev/.../~/auth (or tco://auth in production),
// Expo Router renders this component. maybeCompleteAuthSession() signals the
// in-app browser opened by expo-auth-session to close and pass the auth code
// back to the login() call that initiated the flow.
WebBrowser.maybeCompleteAuthSession();

export default function AuthCallbackScreen() {
  useEffect(() => {
    // maybeCompleteAuthSession already handles closing the browser window.
    // This screen should never be visible to the user for more than a flash.
  }, []);

  return (
    <View style={s.container}>
      <ActivityIndicator size="large" color="#4f46e5" />
      <Text style={s.text}>Anmeldung wird abgeschlossen…</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a", alignItems: "center", justifyContent: "center", gap: 16 },
  text: { color: "#6666aa", fontSize: 15 },
});
