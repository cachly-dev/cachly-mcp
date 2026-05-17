/**
 * Mobile-first layout wrapper.
 * - Handles safe areas (notch, Dynamic Island, home indicator)
 * - Sets dark status bar across all screens
 * - Provides consistent screen-level padding
 */
import { ReactNode } from "react";
import { Platform, StatusBar, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Props = {
  children: ReactNode;
  noPadding?: boolean;
};

export default function Screen({ children, noPadding }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        s.container,
        !noPadding && {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor="#0f0f1a" />
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f0f1a" },
});
