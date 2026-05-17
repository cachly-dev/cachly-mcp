/**
 * Local file cache — downloads attachments and stores them in expo-file-system.
 * Tickets, PDFs and QR-source files are available offline after first fetch.
 */
import * as FileSystem from "expo-file-system";

const CACHE_DIR = `${FileSystem.documentDirectory}tco-cache/`;

export async function ensureCacheDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
}

function cacheKey(url: string): string {
  // stable filename from URL — replace slashes/colons so it's a valid filename
  return url.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function getCachedPath(url: string): Promise<string | null> {
  const path = CACHE_DIR + cacheKey(url);
  const info = await FileSystem.getInfoAsync(path);
  return info.exists ? path : null;
}

export async function downloadAndCache(
  url: string,
  authToken: string
): Promise<string> {
  await ensureCacheDir();
  const path = CACHE_DIR + cacheKey(url);

  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) return path;

  const result = await FileSystem.downloadAsync(url, path, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  if (result.status !== 200) {
    await FileSystem.deleteAsync(path, { idempotent: true });
    throw new Error(`Download failed: ${result.status}`);
  }

  return path;
}

export async function clearCache(): Promise<void> {
  await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
}

export async function cacheSizeBytes(): Promise<number> {
  const info = await FileSystem.getInfoAsync(CACHE_DIR, { size: true });
  return (info.exists && "size" in info) ? (info.size ?? 0) : 0;
}
