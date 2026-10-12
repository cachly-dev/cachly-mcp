/**
 * Geheimnis-Filter — Schluessel und Passwoerter kommen nie in den Bestand.
 *
 * ── Warum es diese Datei gibt (07.10.2026) ──────────────────────────────────
 *
 * Lektionen entstehen mitten in der Arbeit: ein Befehl mit Token, eine
 * Verbindungs-URL mit Passwort, ein kopierter Header. Bis heute ging all das
 * ungeprueft ins Brain — und von dort in jede spaetere Einblendung, ins Team
 * und in Exporte. Die Go-API schwaerzte nur Ereignis-Logs
 * (api/internal/handler/events_handler.go), nie Lektionen.
 *
 * Der Filter SCHWAERZT, er weist nicht ab: ein Agent, der eine Abweisung
 * ignoriert, haette das Geheimnis sonst einfach nicht gespeichert — oder
 * es beim zweiten Versuch leicht umformuliert doch. So landet der Wert nie im
 * Bestand, und die Lektion bleibt brauchbar ("Header Authorization: Bearer
 * [GESCHWAERZT]" lehrt immer noch, wo der Schluessel hingehoert).
 *
 * Nur Formen mit hoher Trefferguete. Platzhalter wie `$TOKEN`, `${KEY}`,
 * `<dein-key>` bleiben stehen — sie sind die gewuenschte Schreibweise.
 *
 * 12.10.2026 (Abhakliste 4.4): gaengige Anbieter-Formate, `DB_PASSWORD=`-Schreibweise,
 * Passwort in Anfuehrungszeichen und TOTP-Seed dazu; Messung gegen die Giftproben:
 * sdk/mcp/src/bench/tuersteher-messen.ts. Anweisungen und gefaehrliche Befehle
 * erkennt tuersteher.ts, nicht diese Datei.
 */

export const GESCHWAERZT = '[GESCHWAERZT]';

interface Muster {
  name: string;
  re: RegExp;
  /** Index der Gruppe, die geschwaerzt wird; ohne Angabe der ganze Treffer. */
  gruppe?: number;
  /** Wert, der wie ein Geheimnis steht, aber keins ist. */
  ausser?: (wert: string) => boolean;
}

// Beispielwerte aus Dokumentationen: `AKIAXXXXXXXXXXXXXXXX`, `ghp_xxxxxxxx...`.
// Zwoelf X in Folge kommen in einem echten Schluessel praktisch nie vor
// (Wahrscheinlichkeit unter 62^-11); gemessen an den Proben (12.10.2026) war das
// der einzige Fehlalarm der Klartext-Geheimnisse.
const PLATZHALTER_X = /x{12,}/i;

// Hat der Wert sowohl Ziffern als auch Buchstaben? Trennt `st.7f3a9c...` von
// `getToken()` und `string`, wo ein Name (kein Schluessel) hinter `token:` steht.
const GEMISCHT = (w: string) => /\d/.test(w) && /[A-Za-z]/.test(w);

// Gemessen am eigenen Bestand (810 Lektionen, 07.10.2026): alle 7 Treffer der
// ersten Fassung waren Verweise statt Werte — `Passwort = PULS_PASSWORD im
// Infisical`, `api_key: os.environ/OPENAI_API_KEY`. Ein Variablenname ist die
// gewuenschte Schreibweise und bleibt stehen.
const VERWEIS = (w: string) => /^[A-Z][A-Z0-9_]{2,}$/.test(w) || /environ|process\.env|secrets\./i.test(w);

// Zugangsdaten zu einer Datenbank auf dem eigenen Rechner (Test-Container)
// sind Teil der Anleitung, kein Geheimnis.
const LOKAL = '(?!(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])[:/\\s])';

const MUSTER: Muster[] = [
  { name: 'privater Schluessel', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { name: 'AWS-Zugangsschluessel', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'GitHub-Token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: 'GitLab-Token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Slack-Token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Stripe-Schluessel', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { name: 'KI-Anbieter-Schluessel', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Weitere gaengige Schluesselformen (feste Vorsilbe, feste Laenge).
  { name: 'Telegram-Bot-Token', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  { name: 'npm-Token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'Google-API-Schluessel', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'SendGrid-Schluessel', re: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { name: 'Hugging-Face-Token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'PyPI-Token', re: /\bpypi-[A-Za-z0-9_-]{40,}\b/g },
  { name: 'Docker-Hub-Token', re: /\bdckr_pat_[A-Za-z0-9_-]{20,}\b/g },
  // `re_` ist auch eine Namensvorsilbe (re_compile_...): erst mit Ziffer ein Schluessel.
  { name: 'Resend-Schluessel', re: /\bre_[A-Za-z0-9_]{20,}\b/g, ausser: (w) => !/\d/.test(w) },
  { name: 'Bearer-Token', re: /\b(?:Bearer|Token)\s+((?![$<{])[A-Za-z0-9._~+/-]{20,}=*)/gi, gruppe: 1 },
  {
    name: 'Basic-Auth-Kopfzeile',
    re: /\bauthorization\s*:\s*basic\s+((?![$<{])[A-Za-z0-9+/]{12,}={0,2})/gi,
    gruppe: 1,
  },
  {
    name: 'Passwort in URL',
    re: new RegExp(`\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:/@]+:((?![$<{])[^\\s/@]{6,})@${LOKAL}`, 'gi'),
    gruppe: 1,
  },
  // Kein \b vor dem Stichwort: `DB_PASSWORD=...` und `AWS_SECRET_ACCESS_KEY=...`
  // sind die haeufigste Schreibweise, und `_` zaehlt als Wortzeichen.
  {
    name: 'Schluessel-Zuweisung',
    re: /(?:password|passwort|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|secret[_-]?key|signing[_-]?key|encryption[_-]?key)["']?\s*[:=]\s*["']?((?![$<{%])[^\s"'`,;)]{8,})/gi,
    gruppe: 1,
    ausser: VERWEIS,
  },
  // `token:` allein ist oft ein Typname (`token: string`) — erst mit Ziffer UND Buchstabe
  // und mindestens zwoelf Zeichen ein Wert.
  {
    name: 'Token-Zuweisung',
    re: /token["']?\s*[:=]\s*["']?((?![$<{%])[^\s"'`,;)]{12,})/gi,
    gruppe: 1,
    ausser: (w) => VERWEIS(w) || !GEMISCHT(w),
  },
  // Passwort in Anfuehrungszeichen ohne `=`: `das Passwort "Sommer2026!"`.
  {
    name: 'Passwort in Anfuehrungszeichen',
    re: /(?:password|passwort|kennwort|passwd)\s+(?:ist\s+|is\s+|lautet\s+)?["„“'‘]((?![$<{%])[^"”“'’\s]{6,})["”“'’]/gi,
    gruppe: 1,
    ausser: VERWEIS,
  },
  // Seed des zweiten Faktors: Base32, mindestens 16 Zeichen.
  {
    name: 'TOTP-Seed',
    re: /\b(?:totp|otp|mfa|2fa)[-_ ]?(?:seed|secret|key|schluessel)\s*[:=]?\s*["']?([A-Z2-7]{16,}=*)/gi,
    gruppe: 1,
    // Ein langes Wort in Kleinbuchstaben ist kein Seed.
    ausser: (w) => /^[a-z]+$/.test(w),
  },
];

export interface Schwaerzung {
  text: string;
  /** Welche Arten gefunden wurden — nie der Wert selbst. */
  funde: string[];
}

/** Schwaerzt bekannte Geheimnisformen in einem Text. */
export function schwaerze(text: string): Schwaerzung {
  let t = String(text ?? '');
  const funde: string[] = [];
  for (const m of MUSTER) {
    t = t.replace(m.re, (treffer: string, ...g: unknown[]) => {
      const wert = m.gruppe === undefined ? treffer : g[m.gruppe - 1];
      // Schon von einem frueheren Muster geschwaerzt — nicht doppelt zaehlen.
      if (typeof wert !== 'string' || !wert || wert.includes(GESCHWAERZT) || PLATZHALTER_X.test(wert) || m.ausser?.(wert)) {
        return treffer;
      }
      funde.push(m.name);
      return m.gruppe === undefined ? GESCHWAERZT : treffer.replace(wert, GESCHWAERZT);
    });
  }
  return { text: t, funde };
}

/**
 * Schwaerzt alle Textfelder einer Lektion (auch Listen wie `commands`).
 * Gibt die bereinigten Felder und die Liste der Funde (Feld: Art) zurueck.
 */
export function schwaerzeFelder<T extends Record<string, unknown>>(felder: T): { felder: T; funde: string[] } {
  const raus: Record<string, unknown> = { ...felder };
  const funde: string[] = [];
  for (const [k, v] of Object.entries(felder)) {
    if (typeof v === 'string') {
      const s = schwaerze(v);
      raus[k] = s.text;
      funde.push(...s.funde.map((f) => `${k}: ${f}`));
    } else if (Array.isArray(v)) {
      raus[k] = v.map((x) => {
        if (typeof x !== 'string') return x;
        const s = schwaerze(x);
        funde.push(...s.funde.map((f) => `${k}: ${f}`));
        return s.text;
      });
    }
  }
  return { felder: raus as T, funde };
}
