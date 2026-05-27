/**
 * Shows a QR code for a booking reference — works fully offline.
 * Uses the booking_ref string to generate the QR locally (no network call).
 * Install: npm install react-native-qrcode-svg react-native-svg
 */
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useEffect, useState } from "react";
// @ts-ignore — added in Phase 3 deps
import QRCode from "react-native-qrcode-svg";

type Props = { bookingRef: string; title?: string };

export default function QRCodeViewer({ bookingRef, title }: Props) {
  const [visible, setVisible] = useState(false);
  const [qrReady, setQrReady] = useState(false);

  useEffect(() => {
    if (visible) {
      const id = requestAnimationFrame(() => setQrReady(true));
      return () => { cancelAnimationFrame(id); setQrReady(false); };
    } else {
      setQrReady(false);
    }
  }, [visible]);

  return (
    <>
      <TouchableOpacity style={s.trigger} onPress={() => setVisible(true)}>
        <Text style={s.triggerText}>QR · {bookingRef}</Text>
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade">
        <TouchableOpacity style={s.backdrop} activeOpacity={1} onPress={() => setVisible(false)}>
          <View style={s.card}>
            <Text style={s.cardTitle}>{title ?? bookingRef}</Text>
            <View style={s.qr}>
              {qrReady
                ? <QRCode value={bookingRef} size={220} backgroundColor="#fff" color="#0f0f1a" />
                : <ActivityIndicator color="#4f46e5" size="large" style={{ width: 220, height: 220 }} />}
            </View>
            <Text style={s.ref}>{bookingRef}</Text>
            <Text style={s.hint}>Antippen zum Schließen</Text>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  trigger: {
    backgroundColor: "#0f0f1a",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: "#4f46e555",
    alignSelf: "flex-start",
  },
  triggerText: { color: "#a5b4fc", fontSize: 12, fontWeight: "500" },
  backdrop: {
    flex: 1,
    backgroundColor: "#000000cc",
    alignItems: "center",
    justifyContent: "center",
  },
  card: {
    backgroundColor: "#1a1a2e",
    borderRadius: 24,
    padding: 32,
    alignItems: "center",
    gap: 16,
    borderWidth: 1,
    borderColor: "#2a2a4e",
  },
  cardTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  qr: { backgroundColor: "#fff", padding: 16, borderRadius: 12 },
  ref: { color: "#6666aa", fontSize: 13, letterSpacing: 1 },
  hint: { color: "#3a3a5e", fontSize: 12 },
});
