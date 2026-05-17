/**
 * Share intent handler — receives files/URLs shared into the app via the tco:// scheme.
 * Works in managed Expo workflow via Linking. Full native share sheets (iOS share extension,
 * Android intent filters) require ejecting or a custom plugin; this handles deep links only.
 */
import * as Linking from "expo-linking";

export type SharedFile = {
  uri: string;
  mimeType: string;
  name: string;
};

/** Parse a tco://share?uri=...&mime=...&name=... deep link into a SharedFile. */
export function parseShareLink(url: string): SharedFile | null {
  try {
    const parsed = Linking.parse(url);
    const uri = parsed.queryParams?.uri as string | undefined;
    const mime = (parsed.queryParams?.mime as string | undefined) ?? "application/octet-stream";
    const name = (parsed.queryParams?.name as string | undefined) ?? "shared-file";
    if (!uri) return null;
    return { uri, mimeType: mime, name };
  } catch {
    return null;
  }
}

/** Subscribe to incoming share links. Returns an unsubscribe function. */
export function onShareIntent(handler: (file: SharedFile) => void): () => void {
  const sub = Linking.addEventListener("url", ({ url }) => {
    if (url.startsWith("tco://share")) {
      const file = parseShareLink(url);
      if (file) handler(file);
    }
  });
  return () => sub.remove();
}

/** Check if the app was launched from a share intent. */
export async function getInitialShareIntent(): Promise<SharedFile | null> {
  const url = await Linking.getInitialURL();
  if (!url || !url.startsWith("tco://share")) return null;
  return parseShareLink(url);
}
