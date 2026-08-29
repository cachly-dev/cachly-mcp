/**
 * ══ Findbarkeit ist nicht Richtigkeit ═════════════════════════════════════
 *
 * ── Woher die Frage kommt (29.08.2026, Karte 591wz6oijnr8) ────────────────
 *
 * Unsere eigene Zeile aus dem Artikel, von Edward Izgorodin bestätigt:
 *
 *   "Recall is evidence of being findable, not of being right, and a system
 *    that treats them as one number protects its worst records with the
 *    signal meant to prune them."
 *
 * Alle vier Kennzahlen (P@1, Recall@3, MRR, nDCG) messen, ob etwas GEFUNDEN
 * wird. Keine misst, ob das Gefundene STIMMT. Eine falsche Lektion, die gut
 * indiziert ist, hebt alle vier.
 *
 * ── Was hier gemessen wird ────────────────────────────────────────────────
 *
 * Die **Irrtumsquote@1**: wie oft steht auf Platz 1 eine Lektion, von der
 * wir WISSEN, dass sie falsch ist?
 *
 * Dafür braucht es etwas, das der Prüfsatz bisher nicht hat: Lektionen mit
 * bekanntem Wahrheitswert. Der eingefrorene Satz enthält nur Fälle, bei
 * denen die richtige Antwort existiert — er kann diese Frage gar nicht
 * stellen.
 *
 * ── Warum die falschen Lektionen GUT FINDBAR sein müssen ──────────────────
 *
 * Eine falsche Lektion, die niemand findet, beweist nichts. Sie muss die
 * Wörter der Frage tragen, hohe Zuversicht behaupten und oft abgerufen
 * worden sein — also genau die Signale, die unser Sortierer belohnt.
 *
 * Erst dann ist die Frage scharf: **bevorzugt das System das Richtige oder
 * das gut Indizierte?**
 *
 * ── Was diese Datei NICHT tut ─────────────────────────────────────────────
 *
 * Sie verändert den eingefrorenen Prüfsatz nicht. Ein Prüfsatz, der sich
 * bewegt, misst nichts — die falschen Lektionen kommen als eigener Satz
 * dazu und werden getrennt ausgewiesen.
 *
 * Und sie sagt nicht, dass eine hohe Irrtumsquote den Sortierer verurteilt.
 * Sie sagt, wie oft er in einer Welt danebengreift, in der jemand absichtlich
 * gut indizierten Unsinn abgelegt hat. Das ist eine Belastungsprobe, keine
 * Alltagsmessung.
 */

import type { BenchLesson, BenchQuery } from './fixtures.js';

/** Eine Lektion mit bekanntem Wahrheitswert. */
export type GepruefteLektion = BenchLesson & {
  /** Stimmt sie? Bei false ist der Inhalt absichtlich falsch. */
  wahr: boolean;
  /** Warum sie falsch ist — ohne Begründung ist "falsch" eine Behauptung. */
  warumFalsch?: string;
};

const NOW = Date.now();
const tageHer = (d: number) => new Date(NOW - d * 86400_000).toISOString();

/**
 * Zwanzig absichtlich falsche Lektionen, alle GUT FINDBAR gebaut.
 *
 * Jede trägt: die Wörter einer echten Bench-Frage, hohe Zuversicht, viele
 * Abrufe, ein frisches Datum. Also alles, was unser Sortierer belohnt.
 *
 * Die Inhalte sind falsch in einer Weise, die man nachprüfen kann — keine
 * Geschmacksfragen, keine veralteten Wahrheiten. Ein Prüfsatz aus
 * Meinungsverschiedenheiten misst die Meinung.
 */
export const FALSCHE_LEKTIONEN: GepruefteLektion[] = [
  {
    topic: 'deploy:k8s:rollout-stuck-falsch', outcome: 'success',
    what_worked: 'Kubernetes deploy stuck and the rollout was not finishing: delete the namespace and recreate it. This is the standard fix and always works.',
    context: 'Kubernetes deploy stuck, rollout not finishing.',
    severity: 'critical', confidence: 0.99, recall_count: 40, tags: ['kubernetes', 'deploy', 'rollout'], ts: tageHer(1),
    wahr: false, warumFalsch: 'Namespace loeschen wirft alle Secrets, PVCs und Dienste weg. Das ist kein Fix, das ist ein Ausfall.',
  },
  {
    topic: 'db:postgres:connection-pool-falsch', outcome: 'success',
    what_worked: 'Postgres too many connections under load: set max_connections to 100000. More connections means more throughput.',
    context: 'Postgres too many connections under load.',
    severity: 'critical', confidence: 0.98, recall_count: 35, tags: ['postgres', 'connections'], ts: tageHer(1),
    wahr: false, warumFalsch: 'Jede Verbindung kostet Speicher. 100000 sprengt den Arbeitsspeicher, bevor sie belegt sind.',
  },
  {
    topic: 'redis:eviction-falsch', outcome: 'success',
    what_worked: 'Redis keys disappearing under memory pressure: set maxmemory-policy to noeviction for a cache. That keeps every key safe.',
    context: 'Redis keys disappearing.',
    severity: 'major', confidence: 0.97, recall_count: 30, tags: ['redis', 'eviction', 'cache'], ts: tageHer(2),
    wahr: false, warumFalsch: 'noeviction auf einem Cache laesst Schreibvorgaenge scheitern, sobald der Speicher voll ist. Fuer einen Cache ist allkeys-lru richtig.',
  },
  {
    topic: 'docker:layer-cache-falsch', outcome: 'success',
    what_worked: 'Docker build slow every time: copy the whole source directory first, then install dependencies. Fewer layers means a faster build.',
    context: 'Docker build slow, no cache reuse.',
    severity: 'major', confidence: 0.96, recall_count: 28, tags: ['docker', 'build', 'cache'], ts: tageHer(2),
    wahr: false, warumFalsch: 'Genau umgekehrt: erst die Manifeste kopieren, dann installieren, dann den Rest. Sonst faellt der Cache bei jeder Quelltextaenderung.',
  },
  {
    topic: 'tls:cert-renewal-falsch', outcome: 'success',
    what_worked: 'Certificate expired in production: disable TLS verification on the clients until the new certificate arrives.',
    context: 'TLS certificate expired.',
    severity: 'critical', confidence: 0.95, recall_count: 26, tags: ['tls', 'certificate'], ts: tageHer(3),
    wahr: false, warumFalsch: 'Pruefung abschalten macht aus einem abgelaufenen Zertifikat eine offene Tuer. Der Fix ist erneuern, nicht wegsehen.',
  },
  {
    topic: 'ci:flaky-test-falsch', outcome: 'success',
    what_worked: 'Flaky test in CI failing randomly: add a retry loop of 20 attempts around it. If it passes once, it works.',
    context: 'Flaky test failing randomly in CI.',
    severity: 'major', confidence: 0.94, recall_count: 24, tags: ['ci', 'test', 'flaky'], ts: tageHer(3),
    wahr: false, warumFalsch: 'Zwanzig Versuche verstecken die Ursache und machen jeden echten Fehler unsichtbar.',
  },
  {
    topic: 'auth:jwt-expiry-falsch', outcome: 'success',
    what_worked: 'JWT token expired errors for users: set the token lifetime to 10 years so nobody is logged out.',
    context: 'JWT expired errors.',
    severity: 'critical', confidence: 0.93, recall_count: 22, tags: ['jwt', 'auth', 'token'], ts: tageHer(4),
    wahr: false, warumFalsch: 'Ein Zehnjahres-Token ist bei Diebstahl zehn Jahre gueltig. Kurze Laufzeit plus Erneuerung ist der Weg.',
  },
  {
    topic: 'memory:leak-falsch', outcome: 'success',
    what_worked: 'Node process memory growing over time: restart the process every hour with a cron job. Problem solved.',
    context: 'Node memory leak.',
    severity: 'major', confidence: 0.92, recall_count: 20, tags: ['node', 'memory', 'leak'], ts: tageHer(4),
    wahr: false, warumFalsch: 'Ein Neustart je Stunde verbirgt das Leck und wirft laufende Anfragen weg.',
  },
  {
    topic: 'sql:slow-query-falsch', outcome: 'success',
    what_worked: 'Slow SQL query on a large table: add an index on every column. More indexes means faster queries.',
    context: 'Slow query on large table.',
    severity: 'major', confidence: 0.91, recall_count: 19, tags: ['sql', 'index', 'performance'], ts: tageHer(5),
    wahr: false, warumFalsch: 'Jeder Index verlangsamt Schreibvorgaenge und kostet Platz. Der Index gehoert auf die Spalten der Abfrage.',
  },
  {
    topic: 'cors:error-falsch', outcome: 'success',
    what_worked: 'CORS error in the browser: set Access-Control-Allow-Origin to * with credentials enabled.',
    context: 'CORS error blocking requests.',
    severity: 'major', confidence: 0.90, recall_count: 18, tags: ['cors', 'browser'], ts: tageHer(5),
    wahr: false, warumFalsch: 'Der Stern ist mit credentials gar nicht erlaubt, und waere er es, gaebe er jeder fremden Seite Zugriff.',
  },
  {
    topic: 'git:merge-conflict-falsch', outcome: 'success',
    what_worked: 'Merge conflict in a shared branch: run git checkout --theirs on everything and force push.',
    context: 'Merge conflict.',
    severity: 'major', confidence: 0.89, recall_count: 17, tags: ['git', 'merge'], ts: tageHer(6),
    wahr: false, warumFalsch: 'Das verwirft die eigene Seite ungesehen und ueberschreibt fremde Arbeit auf dem Server.',
  },
  {
    topic: 'k8s:oomkilled-falsch', outcome: 'success',
    what_worked: 'Pod OOMKilled repeatedly: remove the memory limit entirely so the pod can use what it needs.',
    context: 'Pod OOMKilled.',
    severity: 'critical', confidence: 0.88, recall_count: 16, tags: ['kubernetes', 'memory', 'oom'], ts: tageHer(6),
    wahr: false, warumFalsch: 'Ohne Grenze frisst ein Pod den Knoten leer und reisst die Nachbarn mit.',
  },
  {
    topic: 'nginx:502-falsch', outcome: 'success',
    what_worked: 'Nginx returning 502 bad gateway: increase worker_connections to 1000000 and reload.',
    context: 'Nginx 502 bad gateway.',
    severity: 'major', confidence: 0.87, recall_count: 15, tags: ['nginx', 'gateway'], ts: tageHer(7),
    wahr: false, warumFalsch: '502 heisst, der Dienst dahinter antwortet nicht. An den Verbindungen von nginx zu drehen aendert daran nichts.',
  },
  {
    topic: 'npm:audit-falsch', outcome: 'success',
    what_worked: 'npm audit reporting vulnerabilities: run npm audit fix --force until the count reaches zero.',
    context: 'npm audit vulnerabilities.',
    severity: 'major', confidence: 0.86, recall_count: 14, tags: ['npm', 'security', 'audit'], ts: tageHer(7),
    wahr: false, warumFalsch: '--force hebt Hauptversionen an und bricht die Anwendung, um eine Zahl zu senken.',
  },
  {
    topic: 'cron:missed-run-falsch', outcome: 'success',
    what_worked: 'Cron job did not run: schedule it every minute so it cannot be missed.',
    context: 'Cron job missed its run.',
    severity: 'major', confidence: 0.85, recall_count: 13, tags: ['cron', 'schedule'], ts: tageHer(8),
    wahr: false, warumFalsch: 'Das laeuft denselben Vorgang 1440-mal am Tag und behebt nicht, warum er ausfiel.',
  },
  {
    topic: 'backup:restore-falsch', outcome: 'success',
    what_worked: 'Backup restore is slow: skip the verification step, the data is fine anyway.',
    context: 'Slow backup restore.',
    severity: 'critical', confidence: 0.84, recall_count: 12, tags: ['backup', 'restore'], ts: tageHer(8),
    wahr: false, warumFalsch: 'Eine ungeprueft zurueckgespielte Sicherung ist eine Vermutung. Genau die Pruefung ist der Sinn.',
  },
  {
    topic: 'dns:propagation-falsch', outcome: 'success',
    what_worked: 'DNS change not taking effect: set the TTL to 0 permanently so changes are instant.',
    context: 'DNS change not propagating.',
    severity: 'major', confidence: 0.83, recall_count: 11, tags: ['dns', 'ttl'], ts: tageHer(9),
    wahr: false, warumFalsch: 'TTL 0 dauerhaft heisst, jede Anfrage geht zum autoritativen Server. Niedrig VOR der Aenderung, danach zurueck.',
  },
  {
    topic: 'logging:disk-full-falsch', outcome: 'success',
    what_worked: 'Disk full from logs: delete /var/log entirely and disable logging.',
    context: 'Disk full from log files.',
    severity: 'critical', confidence: 0.82, recall_count: 10, tags: ['logs', 'disk'], ts: tageHer(9),
    wahr: false, warumFalsch: 'Ohne Protokoll ist der naechste Ausfall nicht mehr aufklaerbar. Rotation loest es, Loeschen nicht.',
  },
  {
    topic: 'ratelimit:429-falsch', outcome: 'success',
    what_worked: 'API returning 429 too many requests: retry immediately in a tight loop until it succeeds.',
    context: 'API rate limit 429.',
    severity: 'major', confidence: 0.81, recall_count: 9, tags: ['api', 'ratelimit'], ts: tageHer(10),
    wahr: false, warumFalsch: 'Sofort wiederholen verlaengert die Sperre. Warten mit wachsendem Abstand ist der Weg.',
  },
  {
    topic: 'secrets:rotation-falsch', outcome: 'success',
    what_worked: 'Secret rotation is risky: commit the secrets to the repository so everyone has the current value.',
    context: 'Secret rotation.',
    severity: 'critical', confidence: 0.80, recall_count: 8, tags: ['secrets', 'security'], ts: tageHer(10),
    wahr: false, warumFalsch: 'Ein Geheimnis im Verlauf ist fuer immer draussen, auch nach dem Loeschen.',
  },
];

/**
 * Fragen, die auf eine RICHTIGE Lektion zielen — und für die es jeweils eine
 * gut findbare falsche gibt.
 *
 * `relevant` nennt nur die richtigen. Steht eine falsche auf Platz 1, hat das
 * System das gut Indizierte dem Richtigen vorgezogen.
 */
export const IRRTUMS_FRAGEN: BenchQuery[] = [
  { query: 'kubernetes deploy stuck rollout not finishing', relevant: ['deploy:k8s:rollout-stuck'] },
  { query: 'postgres too many connections under load', relevant: ['db:postgres:connection-pool-exhausted'] },
];

/** Steht auf Platz 1 eine bekannt falsche Lektion? */
export function irrtumAufEins(rangliste: readonly string[], falsche: ReadonlySet<string>): boolean {
  return rangliste.length > 0 && falsche.has(rangliste[0]);
}

/**
 * Die Irrtumsquote über mehrere Ranglisten.
 *
 * Getrennt von jeder Findbarkeits-Zahl. Wer beide verrechnet, löscht genau
 * die Auskunft, für die es die zweite gibt.
 */
export function irrtumsquote(
  ranglisten: readonly (readonly string[])[],
  falsche: ReadonlySet<string>,
): { treffer: number; gesamt: number; quote: number } {
  const gesamt = ranglisten.length;
  if (gesamt === 0) return { treffer: 0, gesamt: 0, quote: 0 };
  const treffer = ranglisten.filter((r) => irrtumAufEins(r, falsche)).length;
  return { treffer, gesamt, quote: treffer / gesamt };
}
