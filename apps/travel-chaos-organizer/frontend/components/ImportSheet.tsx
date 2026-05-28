/**
 * In-app text/email import — paste booking text or email body directly.
 * Calls /parse/text → saves to inbox or a specific trip.
 * Sits above the upload bar in the trip detail and as a standalone entry point.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from "react-native";
import BottomSheet from "./BottomSheet";
import { ApiError, mailApi } from "../lib/api";
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
      await mailApi.import(text.trim(), tripId);
      await haptics.success();
      setText("");
      onClose();
      onSuccess();
      showToast("Dokument erfolgreich importiert", "success");
    } catch (err) {
      await haptics.error();
      if (err instanceof ApiError && err.status === 429) {
        showToast("Tageslimit erreicht (50 Parses/Tag). Upgrade auf Pro.", "warning");
      } else if (err instanceof ApiError && err.status === 408) {
        showToast("Timeout — Ollama antwortet nicht. Bitte warte und versuche es erneut.", "error");
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
    <BottomSheet visible={visible} onClose={handleClose} heightFraction={0.75} hasInputs>
      <View style={{ flex: 1 }}>
        <Text style={s.title}>Text / E-Mail importieren</Text>
        <Text style={s.subtitle}>
          {tripId
            ? "Buchungsbestätigung, E-Mail-Text oder Ticketinhalt einfügen."
            : "Inhalt wird in den Chaos Inbox importiert. E-Mail-Header werden automatisch entfernt."}
        </Text>

        <TextInput
          style={s.input}
          placeholder={"Buchungsbestätigung, weitergeleitete E-Mail oder Tickettext hier einfügen…"}
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
      </View>
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
