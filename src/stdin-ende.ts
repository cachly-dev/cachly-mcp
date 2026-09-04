// Stdin-Ende — der Server stirbt mit seiner Session, statt sie zu ueberleben.
//
// ── Der Befund (31.08.2026, Karte xm54lkjujmyi) ─────────────────────────────
//
// Drei verwaiste MCP-Server auf Heinrichs Laptop, jeder ~26.700 CPU-Sekunden
// in 7,4 Stunden = ein voller Kern DAUERHAFT, je Prozess. Alle drei Eltern
// (die Claude-Sessions) waren tot. Der Server hatte es nie erfahren:
//
//   - Das MCP-SDK (StdioServerTransport) registriert auf stdin nur 'data'
//     und 'error' — KEIN 'end', KEIN 'close'. Endet der Client, endet fuer
//     den Server nur der Datenstrom, nicht das Programm.
//   - Unser eigener Schutz `process.stdin.on('error', () => {})` schluckte
//     den Pipe-Bruch, ohne den Stream zu zerstoeren. Auf Windows liefert die
//     gebrochene Pipe dann Lesefehler in Serie — ein Brand ohne Flamme.
//
// ── Die Regel ───────────────────────────────────────────────────────────────
//
// Im stdio-Betrieb IST stdin die Session. Endet stdin (EOF), bricht es
// (error) oder schliesst es (close), gibt es niemanden mehr, der eine
// Antwort lesen koennte — der einzig richtige Zug ist: aufraeumen und gehen.
// Genau das tun SIGTERM/SIGINT schon; hier kommt derselbe Abgang fuer den
// Weg, auf dem Editoren tatsaechlich sterben (Fenster zu, Prozess gekillt —
// ein Signal schickt auf Windows niemand).
//
// Registriert wird NUR im stdio-Serverzweig. Die CLI-Befehle (configure,
// invite, doctor …) lesen stdin nicht als Kanal; ein globaler Handler
// wuerde `... configure < datei` mitten in der Arbeit beenden.

import type { Readable } from 'node:stream';

/**
 * Ruft `beende(grund)` genau EINMAL, sobald der Stream endet, bricht oder
 * schliesst. Bei einem Fehler wird der Stream zusaetzlich zerstoert — das
 * stoppt die Leseschleife der gebrochenen Windows-Pipe sofort, noch bevor
 * der geordnete Abgang laeuft.
 */
export function beiStdinEnde(stdin: Readable, beende: (grund: string) => void): void {
  let gemeldet = false;
  const einmal = (grund: string) => {
    if (gemeldet) return;
    gemeldet = true;
    beende(grund);
  };
  stdin.once('end', () => einmal('stdin-end'));
  stdin.once('close', () => einmal('stdin-close'));
  stdin.on('error', () => {
    stdin.destroy();
    einmal('stdin-error');
  });
}
