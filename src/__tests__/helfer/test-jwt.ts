// Echte, mit node:crypto unterschriebene Tokens fuer die OAuth-Tests.
// Kein Keycloak, kein Netz: der Test haelt den privaten Schluessel selbst.

import { constants, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface TestAussteller {
  readonly kid: string;
  readonly privat: KeyObject;
  /** Der oeffentliche Schluessel als JWK, wie ihn Keycloak in /certs liefert. */
  readonly jwk: Record<string, unknown>;
}

export function rsaAussteller(kid = 'rsa-1'): TestAussteller {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privat: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

export function ecAussteller(kid = 'ec-1'): TestAussteller {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { kid, privat: privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' } };
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Unterschreibt `ansprueche` mit dem Schluessel des Ausstellers. */
export function unterschreibe(
  a: TestAussteller,
  ansprueche: Record<string, unknown>,
  opt?: { alg?: 'RS256' | 'PS256' | 'ES256'; kid?: string | null; kopf?: Record<string, unknown> },
): string {
  const alg = opt?.alg ?? (a.jwk.kty === 'EC' ? 'ES256' : 'RS256');
  const kopf = { alg, typ: 'JWT', ...(opt?.kid === null ? {} : { kid: opt?.kid ?? a.kid }), ...opt?.kopf };
  const signiert = `${b64(kopf)}.${b64(ansprueche)}`;
  const daten = Buffer.from(signiert);
  let u: Buffer;
  if (alg === 'ES256') u = sign('sha256', daten, { key: a.privat, dsaEncoding: 'ieee-p1363' });
  else if (alg === 'PS256') u = sign('sha256', daten, { key: a.privat, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  else u = sign('sha256', daten, a.privat);
  return `${signiert}.${u.toString('base64url')}`;
}

/** Ansprueche eines Keycloak-Zugangstokens, eine Stunde gueltig. */
export function zugangsAnsprueche(
  aussteller: string,
  zielgruppe: string | string[],
  sub = 'nutzer-1',
  jetztS = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return { iss: aussteller, aud: zielgruppe, sub, typ: 'Bearer', azp: 'dcr-client', iat: jetztS, exp: jetztS + 3600 };
}
