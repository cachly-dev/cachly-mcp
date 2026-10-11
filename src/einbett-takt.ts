// Einbett-Takt — wie schnell index_project Code-Dateien einbetten darf.
//
// ── Warum es das gibt (Abhakliste 1.4, 11.10.2026) ──────────────────────────
//
// Beim ersten Sitzungsstart eines neuen Brains laufen zwei Dinge zugleich:
// der Import der Git-Geschichte legt die ersten Lektionen an, und
// index_project bettet im Hintergrund bis zu 150 Code-Dateien ein, eine nach
// der anderen ohne Pause. Beide teilen sich das Kontingent der API: 60
// Einbettungen je Minute und Konto (api/cmd/server/routes.go, embedLimiter).
//
// Die Lektionen warten bei 429 geduldig (embeddings.ts, Geduld 'lang', bis
// 61 s). Sie gehen also nicht verloren, kommen aber spaeter in die
// Bedeutungssuche — gemessen mit #715: Vektoren erst nach 116 s vollstaendig.
// index_project dagegen gab bei JEDEM 429 sofort auf und fragte fuer die
// naechste Datei gleich wieder an. Code-Dateien nahmen den Lektionen so das
// Kontingent weg, obwohl Lektionen fuer die Suche mehr zaehlen.
//
// ── Was jetzt gilt ──────────────────────────────────────────────────────────
//
//   1. Im Hintergrund (automatischer Lauf beim Sitzungsstart) hoechstens eine
//      Einbettung alle ABSTAND_HINTERGRUND_MS. Das laesst gut die Haelfte des
//      Kontingents fuer die Lektionen frei.
//   2. Beim ersten 429 bleibt es fuer den Rest des Laufs beim Wortindex. Ein
//      weiteres Anfragen in dasselbe volle Fenster bringt nichts.
//   3. Wer index_project selbst aufruft, wartet nicht: dort gilt nur Regel 2.

/** Hoechstens eine Einbettung in dieser Zeit, wenn der Lauf im Hintergrund ist. */
export const ABSTAND_HINTERGRUND_MS = 2_000;

export interface TaktUmfeld {
  /** Laeuft der Lauf im Hintergrund? Nur dann gilt der Abstand. */
  hintergrund: boolean;
  /** Nur fuer Tests. */
  jetzt?: () => number;
  /** Nur fuer Tests. */
  schlafe?: (ms: number) => Promise<void>;
  /** Nur fuer Tests. */
  abstandMs?: number;
}

export interface EinbettTakt {
  /** Darf in diesem Lauf noch eingebettet werden? */
  darf(): boolean;
  /** Vor jeder Einbettung aufrufen: wartet im Hintergrund den Abstand ab. */
  warte(): Promise<void>;
  /** Mit dem Fehler einer Einbettung aufrufen: ein 429 beendet das Einbetten. */
  fehler(fehler: unknown): void;
}

const schlafeEcht = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function einbettTakt(u: TaktUmfeld): EinbettTakt {
  const jetzt = u.jetzt ?? Date.now;
  const schlafe = u.schlafe ?? schlafeEcht;
  const abstand = u.hintergrund ? (u.abstandMs ?? ABSTAND_HINTERGRUND_MS) : 0;
  let gesperrt = false;
  let letzte = Number.NEGATIVE_INFINITY;
  return {
    darf: () => !gesperrt,
    async warte() {
      if (abstand > 0) {
        const rest = letzte + abstand - jetzt();
        if (rest > 0) await schlafe(rest);
      }
      letzte = jetzt();
    },
    fehler(fehler) {
      if ((fehler as { status?: unknown } | null)?.status === 429) gesperrt = true;
    },
  };
}
