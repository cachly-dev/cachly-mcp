import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";

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

export type Tokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export async function login(): Promise<Tokens | null> {
  const redirectUri = AuthSession.makeRedirectUri({ scheme: "tco" });
  const codeVerifier = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    Math.random().toString(),
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );

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
    return null;
  }
}

export async function logout(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}
