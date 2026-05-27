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
  icon: "./assets/icon.svg",
  splash: {
    image: "./assets/splash.svg",
    backgroundColor: "#0f0f1a",
  },
  updates: {
    url: "https://u.expo.dev/019e60b1-8dec-75a9-b252-9cebadf30bd2",
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
      foregroundImage: "./assets/adaptive-icon.svg",
      backgroundColor: "#0f0f1a",
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
        icon: "./assets/icon.svg",
        color: "#4f46e5",
        sounds: [],
      },
    ],
  ],
  extra: {
    eas: { projectId: "019e60b1-8dec-75a9-b252-9cebadf30bd2" },
  },
};

export default config;
