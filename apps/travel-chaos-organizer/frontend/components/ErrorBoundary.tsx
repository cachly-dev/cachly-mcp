import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { captureException } from "../lib/sentry";

type State = { hasError: boolean; error: string | null };

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, error: err.message };
  }

  componentDidCatch(err: Error) {
    captureException(err);
  }

  reset = () => this.setState({ hasError: false, error: null });

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <View style={s.container}>
        <Text style={s.icon}>⚠️</Text>
        <Text style={s.title}>Etwas ist schiefgelaufen</Text>
        <Text style={s.msg}>{this.state.error ?? "Unbekannter Fehler"}</Text>
        <TouchableOpacity style={s.btn} onPress={this.reset} activeOpacity={0.8}>
          <Text style={s.btnText}>Neu laden</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a", justifyContent: "center", alignItems: "center", padding: 32 },
  icon: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 20, fontWeight: "800", color: "#fff", marginBottom: 8, textAlign: "center" },
  msg: { fontSize: 13, color: "#6666aa", textAlign: "center", marginBottom: 32, lineHeight: 20 },
  btn: { backgroundColor: "#4f46e5", paddingVertical: 14, paddingHorizontal: 32, borderRadius: 12 },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
