import { useEffect, useRef } from "react";
import { Animated, Dimensions, StyleSheet, View } from "react-native";

type Props = {
  visible: boolean;
};

const COLORS = ["#4f46e5", "#a5b4fc", "#818cf8", "#c7d2fe", "#f59e0b", "#10b981"];
const COUNT = 24;
const { width } = Dimensions.get("window");

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

type Particle = {
  x: Animated.Value;
  y: Animated.Value;
  opacity: Animated.Value;
  scale: Animated.Value;
  color: string;
  startX: number;
};

export default function ConfettiCannon({ visible }: Props) {
  const particles = useRef<Particle[]>(
    Array.from({ length: COUNT }, (_, i) => ({
      x: new Animated.Value(0),
      y: new Animated.Value(0),
      opacity: new Animated.Value(0),
      scale: new Animated.Value(1),
      color: COLORS[i % COLORS.length],
      startX: rand(0, width),
    }))
  ).current;

  useEffect(() => {
    if (!visible) return;

    particles.forEach((p) => {
      p.x.setValue(0);
      p.y.setValue(0);
      p.opacity.setValue(1);
      p.scale.setValue(1);
    });

    const animations = particles.map((p) => {
      const duration = rand(900, 1200);
      const tx = rand(-150, 150);
      const ty = rand(-300, -50);

      return Animated.parallel([
        Animated.timing(p.x, { toValue: tx, duration, useNativeDriver: true }),
        Animated.timing(p.y, { toValue: ty, duration, useNativeDriver: true }),
        Animated.timing(p.scale, { toValue: 0.3, duration, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(duration * 0.6),
          Animated.timing(p.opacity, { toValue: 0, duration: duration * 0.4, useNativeDriver: true }),
        ]),
      ]);
    });

    Animated.parallel(animations).start();
  }, [visible]);

  if (!visible) return null;

  return (
    <View style={s.container} pointerEvents="none">
      {particles.map((p, i) => (
        <Animated.View
          key={i}
          style={[
            s.particle,
            { backgroundColor: p.color, left: p.startX - 4 },
            {
              opacity: p.opacity,
              transform: [
                { translateX: p.x },
                { translateY: p.y },
                { scale: p.scale },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    position: "absolute",
    bottom: 80,
    left: 0,
    right: 0,
    zIndex: 100,
    pointerEvents: "none",
  } as any,
  particle: {
    position: "absolute",
    width: 10,
    height: 10,
    borderRadius: 5,
    bottom: 0,
  },
});
