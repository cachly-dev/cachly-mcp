import React, { useEffect, useState } from "react";
import {
  Modal, StyleSheet, Text, TouchableOpacity, View, Share, ActivityIndicator,
} from "react-native";
// @ts-ignore — added in Phase 3 deps
import QRCode from "react-native-qrcode-svg";

type Props = {
  tripId: string;
  tripName: string;
  visible: boolean;
  onClose: () => void;
};

export function TripQRModal({ tripId, tripName, visible, onClose }: Props) {
  const deepLink = `tco://trips/${tripId}`;
  const [qrReady, setQrReady] = useState(false);

  useEffect(() => {
    if (visible) {
      // Defer QR generation until after the modal animation frame
      const id = requestAnimationFrame(() => setQrReady(true));
      return () => { cancelAnimationFrame(id); setQrReady(false); };
    } else {
      setQrReady(false);
    }
  }, [visible]);

  async function handleShare() {
    await Share.share({
      message: `Mein Trip "${tripName}" in Travel Chaos Organizer: ${deepLink}`,
    });
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={s.overlay}>
        <View style={s.card}>
          <Text style={s.title}>{tripName}</Text>
          <Text style={s.sub}>QR-Code zum Teilen</Text>
          <View style={s.qrBox}>
            {qrReady
              ? <QRCode value={deepLink} size={180} color="#fff" backgroundColor="#1a1a2e" />
              : <ActivityIndicator color="#4f46e5" size="large" style={{ width: 180, height: 180 }} />}
          </View>
          <Text style={s.link}>{deepLink}</Text>
          <TouchableOpacity style={s.shareBtn} onPress={handleShare} activeOpacity={0.8} accessibilityLabel="Teilen" accessibilityRole="button">
            <Text style={s.shareBtnText}>Teilen</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.closeBtn} onPress={onClose} accessibilityLabel="Schließen" accessibilityRole="button">
            <Text style={s.closeBtnText}>Schließen</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "#000000aa", justifyContent: "center", alignItems: "center" },
  card: { backgroundColor: "#1a1a2e", borderRadius: 24, padding: 28, alignItems: "center", width: 300, gap: 12 },
  title: { fontSize: 18, fontWeight: "800", color: "#fff", textAlign: "center" },
  sub: { fontSize: 12, color: "#6666aa" },
  qrBox: { backgroundColor: "#1a1a2e", padding: 16, borderRadius: 16, borderWidth: 1, borderColor: "#2a2a4a" },
  link: { fontSize: 11, color: "#6666aa", fontFamily: "monospace" },
  shareBtn: { backgroundColor: "#4f46e5", paddingVertical: 12, paddingHorizontal: 32, borderRadius: 12, width: "100%", alignItems: "center" },
  shareBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  closeBtn: { paddingVertical: 8 },
  closeBtnText: { color: "#6666aa", fontSize: 14 },
});
