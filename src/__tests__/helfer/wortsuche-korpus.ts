/**
 * Erzeugt einen wiederholbaren Probebestand aus Lektionen (festes Saatkorn,
 * kein Netz) fuer Zeitmessung und Gleichheitspruefung der Wortsuche.
 * Form wie echte Lektionen: topic, what_worked, what_failed, context,
 * file_paths, commands, tags; deutsch/englisch gemischt, mit Bezeichnern,
 * Pfaden, Adressen und Hashes (grosser, langschwaenziger Wortschatz).
 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DE = ('der die das nicht wird wurde laeuft fehlt gesetzt gestartet Server Knoten Anmeldung Ausrollen Abnahme Schluessel ' +
  'Zwischenspeicher Datenbank Verbindung Zeitgrenze Platte voll Neustart Pruefung Lektion Wortsuche Bestand Messung Befund ' +
  'Sicherung Zugang Tunnel Adresse Dienst Container Warteschlange Mandant Rechnung Ausfall Ursache Loesung Hinweis ' +
  'gemessen geaendert geprueft behoben verloren gefunden gebaut gestoppt abgelaufen erreichbar langsam doppelt veraltet').split(' ');
const EN = ('deploy deployment api node caddy proxy server timeout retry cache redis docker compose volume network config env secret token ' +
  'migration schema index query search ranking score latency memory cpu disk firewall certificate renew dns resolver upstream ' +
  'health check restart crash loop privilege separation daemon systemd journal logs metrics alert gateway webhook queue worker ' +
  'build pipeline runner artifact release version rollback branch merge commit hook lint test fixture mock stub bundle plugin ' +
  'keycloak realm client oauth session cookie header body payload parse stream buffer socket tls handshake backoff quota limit').split(' ');
const TLD = ['ts', 'tsx', 'mjs', 'yml', 'json', 'sh', 'md', 'go', 'sql'];

export function erzeugeLektionen(anzahl: number, saat = 20260819): Array<{ key: string; content: string }> {
  const r = rng(saat);
  const pick = <T>(a: T[]): T => a[Math.floor(Math.pow(r(), 1.7) * a.length)];
  const kennung = (): string => {
    const t = r();
    const w = (): string => pick(EN);
    if (t < 0.3) return `${w()}${w()[0].toUpperCase()}${w().slice(1)}`;
    if (t < 0.5) return `${w()}_${w()}_${Math.floor(r() * 900)}`;
    if (t < 0.65) return `${w()}-${w()}`;
    if (t < 0.75) return `node-${1 + Math.floor(r() * 4)}`;
    if (t < 0.85) return `10.8.0.${Math.floor(r() * 250)}:${3000 + Math.floor(r() * 900)}`;
    if (t < 0.93) return Math.floor(r() * 1e8).toString(16);
    return `v${Math.floor(r() * 3)}.${Math.floor(r() * 20)}.${Math.floor(r() * 300)}`;
  };
  const pfad = (): string => `${pick(['src', 'sdk/mcp/src', 'infra', '.github/workflows', 'scripts', 'api/internal'])}/${pick(EN)}-${pick(EN)}.${pick(TLD)}`;
  const satz = (n: number): string => {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = r();
      out.push(t < 0.4 ? pick(DE) : t < 0.75 ? pick(EN) : t < 0.92 ? kennung() : pfad());
    }
    return out.join(' ');
  };
  const tage = 400;
  const jetzt = Date.UTC(2026, 10, 19);
  const lektionen: Array<{ key: string; content: string }> = [];
  for (let i = 0; i < anzahl; i++) {
    const topic = `${pick(['deploy', 'ci', 'node', 'api', 'brain', 'bench', 'caddy', 'auth'])}:${pick(EN)}-${pick(EN)}-${i}`;
    const lang = 100 + Math.floor(r() * 500);
    const obj = {
      topic,
      outcome: r() < 0.7 ? 'success' : 'failure',
      what_worked: satz(Math.floor(lang * 0.45)),
      what_failed: satz(Math.floor(lang * 0.2)),
      context: satz(Math.floor(lang * 0.25)),
      file_paths: Array.from({ length: Math.floor(r() * 4) }, pfad),
      commands: Array.from({ length: Math.floor(r() * 3) }, () => `${pick(EN)} ${pick(EN)} --${pick(EN)} ${kennung()}`),
      tags: Array.from({ length: 1 + Math.floor(r() * 4) }, () => pick(EN)),
      severity: pick(['minor', 'major', 'critical']),
      created_at: new Date(jetzt - Math.floor(r() * tage) * 86400000).toISOString(),
    };
    lektionen.push({ key: `cachly:lesson:best:${topic}`, content: JSON.stringify(obj) });
  }
  return lektionen;
}

export const PROBEFRAGEN: string[] = [
  'deploy api node-1 caddy', 'Wortsuche Bestand Messung langsam', 'Anmeldung Zeitgrenze Neustart',
  'timeout retry backoff upstream', 'redis cache volume docker compose', 'keycloak realm oauth session cookie',
  'warum laeuft der Server nach dem Ausrollen nicht', 'Zwischenspeicher veraltet Datenbank Verbindung',
  'migration schema index query', 'firewall certificate renew dns', 'timout retri bakoff', 'deploymnt gatway webhok',
  'sdk/mcp/src/search.ts', '10.8.0.7:3095 whisper', 'v0.10.241 plugin hook bundle', 'zzzzqqq wwwxxyyy kkkjjj',
  'Platte voll; Neustart Sicherung', '1. deploy api 2. caddy proxy upstream', 'build pipeline runner artifact, release version rollback, branch merge commit',
  'Ausfall Ursache Loesung Hinweis', 'systemd journal logs metrics alert', 'node-3 monitoring alert gateway',
  'privilege separation daemon crash loop', 'tls handshake socket buffer stream', 'lint test fixture mock stub',
  'Sicherung Zugang Tunnel Adresse', 'quota limit backoff queue worker and also deploy api', 'cache invalidation stale',
  'Mandant Rechnung Container Warteschlange', 'healthcheck restart', 'deployAPI nodeCaddy', 'migraton schmea', 'worker_queue_42',
  'Pruefung Lektion Befund gemessen', 'index_project hash', 'caddy', 'api', 'Verbindung', 'abgelaufen erreichbar langsam doppelt',
  'secret token env config', 'payload header body parse', 'resolver dns upstream timeout', 'ci runner build node-4',
  'bundle plugin hook mcp', 'fehlt gesetzt gestartet', 'rollback release deploy node-2', 'webhook retry queue',
  'cpu memory disk latency', 'loop crash privilege', 'verloren gefunden gebaut gestoppt', 'tsx mjs yml json sh',
  'github workflows ci yml', 'neu bauen Schluessel Zwischenspeicher', 'kontena depuroi', 'xylophon quark',
];
