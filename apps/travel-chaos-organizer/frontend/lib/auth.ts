import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";

// NOTE: maybeCompleteAuthSession() must also be called in app/auth.tsx
// (the callback route). The call here is a belt-and-suspenders fallback.
WebBrowser.maybeCompleteAuthSession();

const KEYCLOAK_URL = process.env.EXPO_PUBLIC_KEYCLOAK_URL!;
const REALM = process.env.EXPO_PUBLIC_KEYCLOAK_REALM!;
const CLIENT_ID = process.env.EXPO_PUBLIC_KEYCLOAK_CLIENT_ID!;

const discovery = {
  authorizationEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth`,
  tokenEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`,
  revocationEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout`,
};

const TOKEN_KEY = "tco_tokens";

export let onAuthFailure: (() => void) | null = null;
export function setAuthFailureCallback(cb: () => void) { onAuthFailure = cb; }

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export async function login(): Promise<Tokens | null> {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "tco", path: "auth" });
  // RFC 7636: code_verifier must be 43–128 chars of unreserved ASCII (Base64URL, no padding).
  // Use cryptographically secure random bytes, not Math.random() + SHA256.
  const randomBytes = await Crypto.getRandomBytesAsync(32);
  const codeVerifier = btoa(String.fromCharCode(...randomBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  const request = new AuthSession.AuthRequest({
    clientId: CLIENT_ID,
    redirectUri,
    scopes: ["openid", "profile", "email", "offline_access"],
    usePKCE: true,
    codeVerifier,
  });

  const result = await request.promptAsync(discovery);
  if (result.type !== "success") return null;

  const tokenResult = await AuthSession.exchangeCodeAsync(
    {
      clientId: CLIENT_ID,
      code: result.params.code,
      redirectUri,
      extraParams: { code_verifier: codeVerifier },
    },
    discovery
  );

  const tokens: Tokens = {
    accessToken: tokenResult.accessToken,
    refreshToken: tokenResult.refreshToken!,
    expiresAt: Date.now() + (tokenResult.expiresIn ?? 300) * 1000,
  };
  await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  return tokens;
}

export async function getAccessToken(): Promise<string | null> {
  const raw = await AsyncStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  const tokens: Tokens = JSON.parse(raw);

  if (Date.now() < tokens.expiresAt - 30_000) return tokens.accessToken;

  // refresh
  try {
    const refreshed = await AuthSession.refreshAsync(
      { clientId: CLIENT_ID, refreshToken: tokens.refreshToken },
      discovery
    );
    const updated: Tokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      expiresAt: Date.now() + (refreshed.expiresIn ?? 300) * 1000,
    };
    await AsyncStorage.setItem(TOKEN_KEY, JSON.stringify(updated));
    return updated.accessToken;
  } catch {
    await AsyncStorage.removeItem(TOKEN_KEY);
    onAuthFailure?.();
    return null;
  }
}

export async function logout(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}
