import { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Travel Chaos Organizer",
  slug: "travel-chaos-organizer",
  version: "0.1.0",
  scheme: "tco",
  runtimeVersion: {
    policy: "appVersion",
  },
  orientation: "portrait",
  icon: "./assets/icon.png",
  splash: {
    image: "./assets/splash.png",
    backgroundColor: "#1a1a2e",
  },
  updates: {
    url: "https://u.expo.dev/YOUR_EAS_PROJECT_ID",
    enabled: true,
    fallbackToCacheTimeout: 0,
    checkAutomatically: "ON_LOAD",
  },
  ios: {
    bundleIdentifier: "dev.cachly.tco",
    supportsTablet: true,
  },
  android: {
    package: "dev.cachly.tco",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#1a1a2e",
    },
  },
  plugins: [
    "expo-router",
    "expo-sqlite",
    "expo-updates",
    ["expo-image-picker", { photosPermission: "Allow TCO to access your photos for travel document scanning." }],
    ["expo-document-picker", {}],
    [
      "expo-notifications",
      {
        icon: "./assets/icon.png",
        color: "#4f46e5",
        sounds: [],
      },
    ],
  ],
  extra: {
    eas: { projectId: "YOUR_EAS_PROJECT_ID" },
  },
};

export default config;
