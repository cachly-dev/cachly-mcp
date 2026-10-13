// Einstieg des Hook-Buendels hooks/cachly-ambient-einblendung.mjs.
//
// Nur diese Datei hat Seiteneffekte: sie liest die Argumente und startet den
// Lauf. Die Logik steht in ambient-hook.ts (getestet ohne Prozess).
//
//   node cachly-ambient-einblendung.mjs <Ereignis> [--plugin]          ein Hook-Lauf
//   node cachly-ambient-einblendung.mjs ambient-auffrischen            Bestand auffrischen
//   node cachly-ambient-einblendung.mjs startwissen-import <ordner>    Start-Import eines neuen Brains
//
// `selbst` ist der Pfad DIESER Datei, nicht process.argv[1]: Die Projekt-Hooks
// laden das Buendel per import, dort zeigt argv[1] auf den kleinen Hook davor.

import { fileURLToPath } from 'node:url';
import { AUFFRISCHEN, auffrischenHauptlauf, hookHauptlauf, startwissenImportHauptlauf } from './ambient-hook.js';
import { STARTWISSEN_IMPORT } from './startwissen-hook.js';

const args = process.argv.slice(2);
if (args[0] === AUFFRISCHEN) await auffrischenHauptlauf();
else if (args[0] === STARTWISSEN_IMPORT) await startwissenImportHauptlauf(args[1] ?? '');
else await hookHauptlauf(args, fileURLToPath(import.meta.url));
