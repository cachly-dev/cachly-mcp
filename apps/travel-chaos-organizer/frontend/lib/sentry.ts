/**
 * Sentry integration — no-op when EXPO_PUBLIC_SENTRY_DSN is not set.
 * Call initSentry() once at app startup.
 */

export function initSentry(): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;

  // Lazy import to avoid bundling Sentry when not configured
  import("@sentry/react-native").then((Sentry) => {
    const integrations = typeof (Sentry as any).reactNativeTracingIntegration === "function"
      ? [(Sentry as any).reactNativeTracingIntegration()]
      : [];
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      integrations,
      environment: __DEV__ ? "development" : "production",
    });
  }).catch(() => undefined);
}

export function captureException(err: unknown): void {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  import("@sentry/react-native").then(({ captureException: cap }) => cap(err as Error)).catch(() => undefined);
}
