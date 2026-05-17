/**
 * In-app text/email import — paste booking text or email body directly.
 * Calls /parse/text → saves to inbox or a specific trip.
 * Sits above the upload bar in the trip detail and as a standalone entry point.
 */
import { useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import BottomSheet from "./BottomSheet";
import { haptics } from "../lib/haptics";
import { useToast } from "./ToastContext";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** If provided, parse result goes directly to this trip. Otherwise → inbox. */
  tripId?: string;
  onSuccess: () => void;
};

export default function ImportSheet({ visible, onClose, tripId, onSuccess }: Props) {
  const { showToast } = useToast();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    await haptics.confirm();

    try {
      const { getAccessToken } = await import("../lib/auth");
      const BASE = process.env.EXPO_PUBLIC_API_URL!;
      const token = await getAccessToken();
      if (!token) throw new Error("Not authenticated");

      const form = new FormData();
      form.append("raw_text", text.trim());
      if (tripId) form.append("trip_id", tripId);

      const res = await fetch(`${BASE}/api/v1/parse/text`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!res.ok) {
        const err = await res.text();
        const error = new Error(`${res.status}: ${err}`) as Error & { status: number };
        (error as any).status = res.status;
        throw error;
      }

      await haptics.success();
      setText("");
      onClose();
      onSuccess();
      showToast("Dokument erfolgreich importiert", "success");
    } catch (err: any) {
      await haptics.error();
      if (err?.status === 429) {
        showToast("Tageslimit erreicht (50 Parses/Tag). Upgrade auf Pro.", "warning");
      } else {
        setError(err instanceof Error ? err.message : "Unbekannter Fehler");
      }
    } finally {
      setLoading(false);
    }
  }

  function handleClose() {
    setText("");
    setError(null);
    onClose();
  }

  return (
    <BottomSheet visible={visible} onClose={handleClose} heightFraction={0.75}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <Text style={s.title}>Text importieren</Text>
        <Text style={s.subtitle}>
          {tripId
            ? "Füge eine Buchungsbestätigung, E-Mail oder Tickettext ein."
            : "Inhalt wird in den Chaos Inbox importiert."}
        </Text>

        <TextInput
          style={s.input}
          placeholder={"Buchungsbestätigung, E-Mail oder Tickettext hier einfügen…"}
          placeholderTextColor="#4a4a7a"
          value={text}
          onChangeText={setText}
          multiline
          numberOfLines={8}
          autoFocus
          textAlignVertical="top"
          accessibilityLabel="Buchungstext eingeben"
        />

        {error && (
          <View style={s.errorBox}>
            <Text style={s.errorText}>⚠️  {error}</Text>
          </View>
        )}

        <View style={s.buttons}>
          <TouchableOpacity
            style={s.cancelBtn}
            onPress={handleClose}
            accessibilityRole="button"
            accessibilityLabel="Abbrechen"
          >
            <Text style={s.cancelText}>Abbrechen</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.submitBtn, (!text.trim() || loading) && s.submitDisabled]}
            onPress={submit}
            disabled={loading || !text.trim()}
            accessibilityRole="button"
            accessibilityLabel="Text mit Ollama analysieren"
          >
            {loading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={s.submitText}>Analysieren ✨</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </BottomSheet>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 18, fontWeight: "700", color: "#fff", marginBottom: 4 },
  subtitle: { fontSize: 13, color: "#6666aa", marginBottom: 12, lineHeight: 18 },
  input: {
    flex: 1,
    backgroundColor: "#0f0f1a",
    borderRadius: 12,
    padding: 14,
    color: "#fff",
    fontSize: 14,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: "#2a2a4e",
    marginBottom: 12,
    minHeight: 120,
  },
  errorBox: {
    backgroundColor: "#ff6b6b18",
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#ff6b6b33",
  },
  errorText: { color: "#ff8888", fontSize: 13 },
  buttons: { flexDirection: "row", gap: 12, justifyContent: "flex-end" },
  cancelBtn: {
    paddingVertical: 12, paddingHorizontal: 20,
    borderRadius: 10, borderWidth: 1, borderColor: "#2a2a4e",
  },
  cancelText: { color: "#8888aa", fontSize: 15 },
  submitBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    backgroundColor: "#4f46e5", alignItems: "center",
  },
  submitDisabled: { opacity: 0.45 },
  submitText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
