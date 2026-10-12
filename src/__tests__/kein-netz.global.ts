/**
 * Globales Setup: das Zaehlwerk der Netzsperre.
 *
 * Die Sperre (scripts/kein-netz-vorlauf.cjs) schreibt jeden blockierten Versuch
 * in CACHLY_NETZSPERRE_LOG — auch den von Kindprozessen, die ein Test startet
 * und die der Pruefung nach jedem Test (kein-netz.setup.ts) entgehen. Am Ende
 * des Laufs wird die Datei gelesen: ein unbeabsichtigter Versuch laesst den
 * ganzen Lauf rot werden, und die Summe steht IMMER im Protokoll.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';

interface Zeile { host: string; port: number | null; erwartet: boolean; test?: string; befehl?: string }

export default function setup(): () => void {
  const pfad = process.env.CACHLY_NETZSPERRE_LOG;
  if (pfad) rmSync(pfad, { force: true });

  return () => {
    if (process.env.CACHLY_NETZSPERRE === 'aus') {
      console.log('[netzsperre] AUS (CACHLY_NETZSPERRE=aus) — dieser Lauf darf ins Netz');
      return;
    }
    let zeilen: Zeile[] = [];
    if (pfad && existsSync(pfad)) {
      zeilen = readFileSync(pfad, 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z) as Zeile);
      rmSync(pfad, { force: true });
    }
    const offen = zeilen.filter((z) => !z.erwartet);
    console.log(
      `[netzsperre] ${offen.length} Verbindungsversuche nach aussen (blockiert)` +
      `, ${zeilen.length - offen.length} absichtliche aus dem Waechter-Test`,
    );
    if (offen.length > 0) {
      const liste = offen.slice(0, 10).map((z) => `  ${z.host}:${z.port}  ${z.test || z.befehl || ''}`).join('\n');
      throw new Error(`Netzsperre: ${offen.length} Test-Verbindung(en) nach aussen blockiert:\n${liste}`);
    }
  };
}
