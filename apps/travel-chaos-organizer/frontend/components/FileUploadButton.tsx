import { StyleSheet, Text, TouchableOpacity } from "react-native";

type Props = { icon: string; label: string; onPress: () => void; disabled?: boolean };

export default function FileUploadButton({ icon, label, onPress, disabled }: Props) {
  return (
    <TouchableOpacity style={[s.btn, disabled && s.btnDisabled]} onPress={onPress} disabled={disabled} activeOpacity={0.8}>
      <Text style={s.icon}>{icon}</Text>
      <Text style={s.label}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: "#0f0f1a", borderRadius: 12, paddingVertical: 12, borderWidth: 1, borderColor: "#2a2a4e" },
  btnDisabled: { opacity: 0.4 },
  icon: { fontSize: 18 },
  label: { color: "#a5b4fc", fontSize: 14, fontWeight: "500" },
});
