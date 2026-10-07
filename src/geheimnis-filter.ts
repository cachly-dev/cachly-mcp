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
  { name: 'Bearer-Token', re: /\b(?:Bearer|Token)\s+((?![$<{])[A-Za-z0-9._~+/-]{20,}=*)/gi, gruppe: 1 },
  {
    name: 'Passwort in URL',
    re: new RegExp(`\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:/@]+:((?![$<{])[^\\s/@]{6,})@${LOKAL}`, 'gi'),
    gruppe: 1,
  },
  {
    name: 'Schluessel-Zuweisung',
    re: /\b(?:password|passwort|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*["']?((?![$<{%])[^\s"'`,;)]{8,})/gi,
    gruppe: 1,
    ausser: VERWEIS,
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
      if (m.gruppe === undefined) {
        funde.push(m.name);
        return GESCHWAERZT;
      }
      const wert = g[m.gruppe - 1];
      // Schon von einem frueheren Muster geschwaerzt — nicht doppelt zaehlen.
      if (typeof wert !== 'string' || !wert || wert.includes(GESCHWAERZT) || m.ausser?.(wert)) return treffer;
      funde.push(m.name);
      return treffer.replace(wert, GESCHWAERZT);
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
