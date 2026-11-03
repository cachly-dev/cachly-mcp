// Kleine, reine Helfer fuer die Befehlszeile (index.ts). Eigene Datei, damit
// die Regeln ohne Serverstart testbar sind (Befunde cli-1, cli-5, cli-6, 03.11.2026).

/** Jeder Befehl, den index.ts als process.argv[2] kennt. */
export const BEKANNTE_BEFEHLE: readonly string[] = [
  'ambient-auffrischen', 'ambient-credit', 'ambient-recall', 'ambient-stats', 'autopilot', 'autosetup',
  'badge', 'bench', 'claim', 'cls-ingest', 'demo', 'digest', 'doctor', 'export', 'health', 'index', 'init',
  'invite', 'join', 'learn-git', 'openapi', 'publish', 'setup', 'share', 'startwissen-import', 'status',
  'tool-specs', 'uninstall', 'upgrade',
];

export type ArgumentArt = 'server' | 'hilfe' | 'version' | 'unbekannt';

/**
 * Was ist mit dem ersten Argument zu tun?
 *
 * cli-5 (03.11.2026): `--help`, `--version` und Tippfehler wie `inti` starteten
 * still den Stdio-Server. Der MCP-Client startet ohne Argument und mit Pipes;
 * deshalb gilt "unbekannt" nur, wenn stdin ein Terminal ist (ein Mensch tippt).
 */
export function klassiereArgument(arg: string | undefined, stdinIstTerminal: boolean): ArgumentArt {
  if (arg === undefined || arg === '') return 'server';
  if (arg === '--help' || arg === '-h' || arg === 'help') return 'hilfe';
  if (arg === '--version' || arg === '-v' || arg === 'version') return 'version';
  if (BEKANNTE_BEFEHLE.includes(arg)) return 'server';
  return stdinIstTerminal ? 'unbekannt' : 'server';
}

/** Wert eines `--name <wert>`-Flags, oder undefined, wenn er fehlt. Ein folgendes `--flag` ist kein Wert. */
export function leseFlag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const wert = argv[i + 1];
  return wert === undefined || wert.startsWith('--') ? undefined : wert;
}

/** Flags, die in argv stehen, aber keinen Wert haben (z. B. `--instance-id --api-key abc`). */
export function flagsOhneWert(argv: readonly string[], namen: readonly string[]): string[] {
  return namen.filter((n) => argv.includes(`--${n}`) && leseFlag(argv, n) === undefined);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pruefung von Instanz, Schluessel und Editor fuer `init`. Leere Liste = in Ordnung. */
export function pruefeInitEingaben(
  e: { instanceId: string; apiKey: string; editor: string },
  erlaubteEditoren: readonly string[],
): string[] {
  const fehler: string[] = [];
  if (!UUID.test(e.instanceId)) {
    fehler.push(`The instance ID "${e.instanceId.slice(0, 40)}" is not a UUID. Copy it from the dashboard (Instances > your brain).`);
  }
  // Langer Schluessel (cky_...) oder JWT (drei Teile mit Punkt).
  const istJwt = e.apiKey.split('.').length === 3;
  if (!e.apiKey.startsWith('cky_') && !istJwt) {
    fehler.push('The API key does not look right. It starts with "cky_" (or is a JWT with three parts).');
  }
  if (!erlaubteEditoren.includes(e.editor)) {
    fehler.push(`Unknown editor "${e.editor}". Allowed: ${erlaubteEditoren.join(', ')}.`);
  }
  return fehler;
}
