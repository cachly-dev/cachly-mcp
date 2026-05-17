import { View, Text, StyleSheet } from "react-native";
// @ts-ignore — react-native-svg is a peer dep of react-native-qrcode-svg
import Svg, { Circle } from "react-native-svg";

type Props = { score: number; size?: number };

export default function ScoreRing({ score, size = 40 }: Props) {
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;
  const gap = circumference - filled;

  const color = score === 100 ? "#10b981" : score >= 50 ? "#4f46e5" : "#3a3a5e";

  return (
    <View style={[s.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke="#2a2a4e" strokeWidth={stroke} fill="none"
        />
        <Circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={`${filled} ${gap}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <Text style={[s.label, { color }]}>{score}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", position: "relative" },
  label: { position: "absolute", fontSize: 10, fontWeight: "700" },
});
