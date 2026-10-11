/**
 * Der Kundenweg blendet ein — sortiert und gerahmt.
 *
 * ── Warum dieser Test (08.10.2026) ──────────────────────────────────────────
 *
 * Kunden bekommen per `init`/`autopilot` Hooks, die `cachly ambient-recall`
 * aufrufen. Dieser Befehl rief bis heute `smart_recall` mit 3 s Zeitdeckel
 * und blendete bei 10 echten Fachfragen 0 Lektionen ein. Unsere eigene
 * Repo-Fassung (tools/ambient-recall/) sortierte dieselben Fragen lokal und
 * traf. Jetzt rufen beide denselben Kern (einblendung.ts).
 *
 * Dieser Test faehrt `runEinblendung` — genau die Funktion, die der Befehl
 * ruft (der Verdrahtungs-Test unten haelt das fest) — mit einer echten
 * Hook-Eingabe gegen einen Fixture-Bestand.
 *
 * ── Gegenprobe ─────────────────────────────────────────────────────────────
 *
 * Die richtige Lektion liegt im Bestand GANZ HINTEN, davor stehen fuenf
 * Lektionen mit hoeherer Abrufzahl, die das Tor ebenfalls passieren. Ohne
 * Rangfolge (Bestand in Lieferreihenfolge, Tor, die ersten drei) fehlt sie in
 * der Einblendung — das prueft der Test "ohne Rangfolge" ausdruecklich.
 * Gefahren am 08.10.2026: `sortiere(prompt)` in einblendung.ts durch die
 * Lieferreihenfolge ersetzt -> "Fachfrage liefert die passende Lektion" rot.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { runEinblendung } from '../ambient-cli.js';
import { bestandPfad, torWoerter, zaehleBelege, RAHMEN_ETIKETT, type EinblendLektion } from '../einblendung.js';
import { lektionsText } from '../seltenheitsbestand.js';
import { buildUserPromptSubmitHook, AMBIENT_CLI_SUBCOMMAND, HOOK_BUENDEL } from '../ambient-hooks.js';

const FRAGE = 'Warum meldet der Deploy auf node-1 connection refused, obwohl WireGuard aktiv ist?';
const RICHTIG = 'betrieb:fail2ban-bannt-deploy-kanal';

// Lieferreihenfolge wie aus /export: die Ablenker zuerst, die richtige zuletzt.
const BESTAND: EinblendLektion[] = [
  { topic: 'deploy:runner-ablauf', what_worked: 'Der Deploy auf node-1 laeuft ueber den Runner auf node-3. Meldet der Job Erfolg, trotzdem die Logs pruefen.', outcome: 'success', recall_count: 500 },
  { topic: 'monitoring:node-meldet-alarm', what_worked: 'node-3 meldet Alarm, wenn die Platte voll ist; danach den Deploy neu anstossen.', outcome: 'success', recall_count: 400 },
  { topic: 'docker:layer-cache', what_worked: 'Deploy schneller machen: Paketmanifeste zuerst kopieren, damit die Node-Abhaengigkeiten im Zwischenspeicher bleiben.', outcome: 'success', recall_count: 900 },
  { topic: 'kanzlei:feature-flag', what_worked: 'Kanzlei-Funktionen schaltet man aktiv ueber ein Feature-Flag; der Deploy auf node-2 liest es beim Start.', outcome: 'success', recall_count: 300 },
  { topic: 'tco:deploy-meldet-gruen', what_worked: 'Der Deploy meldet gruen, obwohl alembic nie lief — Migrationen im Deploy-Skript ausdruecklich starten.', outcome: 'failure', recall_count: 200 },
  {
    topic: RICHTIG,
    what_worked: 'fail2ban auf node-1 bannte den WireGuard-Peer 10.8.0.6; der Deploy meldete connection refused, obwohl WireGuard aktiv war. '
      + 'Abhilfe: ignoreip 10.8.0.0/24 in jail.local und fail2ban neu starten.',
    outcome: 'success', severity: 'critical', recall_count: 2,
  },
];

const benutzt = new Set<string>();
function cfg(name: string) {
  const instanceId = `test-kundenweg-${name}-${process.pid}`;
  benutzt.add(instanceId);
  return { apiUrl: 'http://fixture.invalid', jwt: 'test-schluessel', instanceId };
}
afterAll(() => { for (const id of benutzt) rmSync(bestandPfad(id), { force: true }); });

type Leser = 'aus' | 'haengt' | ((texte: string[]) => number[]);

/** Ein fetch, der /export mit dem Fixture beantwortet und /rerank nach Vorgabe. */
function netz(leser: Leser): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/export')) {
      return new Response(JSON.stringify({ lessons: BESTAND.map((l) => JSON.stringify(l)) }), { status: 200 });
    }
    if (u.endsWith('/api/v1/rerank')) {
      if (leser === 'aus') return new Response('{}', { status: 503 });
      if (leser === 'haengt') {
        return new Promise<Response>((_, ablehnen) => {
          init?.signal?.addEventListener('abort', () => ablehnen(new Error('abgebrochen')));
        });
      }
      const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
      return new Response(JSON.stringify({ scores: leser(texts), provider: 'test', ms: 1 }), { status: 200 });
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

function eingabe(prompt: string): string {
  return JSON.stringify({ session_id: 's', cwd: '/repo', hook_event_name: 'UserPromptSubmit', prompt });
}

/** Die Themen der eingeblendeten Lektionen, in Reihenfolge — nur aus dem Rahmen. */
function themenImRahmen(ausgabe: string): string[] {
  const ctx: string = JSON.parse(ausgabe).hookSpecificOutput.additionalContext;
  const innen = ctx.slice(ctx.indexOf(`<${RAHMEN_ETIKETT}>`), ctx.indexOf(`</${RAHMEN_ETIKETT}>`));
  return innen.split('\n').filter((z) => z.startsWith('- ')).map((z) => z.replace(/^- (\[[a-z]+\] )?/, '').split(': ')[0]);
}

describe('Kundenweg (cachly ambient-recall) — Fachfrage gegen den Fixture-Bestand', () => {
  it('Fachfrage liefert die passende Lektion zuerst, im Rahmen', async () => {
    const aus = await runEinblendung(eingabe(FRAGE), { cfg: cfg('rang'), fetchFn: netz('aus'), protokoll: false });
    expect(aus).not.toBe('');
    const j = JSON.parse(aus);
    expect(j.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    const ctx: string = j.hookSpecificOutput.additionalContext;
    // Gerahmt: genau ein Rahmen, die Lektion steht darin.
    expect(ctx.split(`<${RAHMEN_ETIKETT}>`).length - 1).toBe(1);
    expect(ctx.split(`</${RAHMEN_ETIKETT}>`).length - 1).toBe(1);
    const themen = themenImRahmen(aus);
    expect(themen.length).toBeGreaterThan(0);
    expect(themen.length).toBeLessThanOrEqual(3);
    expect(themen[0]).toBe(RICHTIG);
  });

  it('ohne Rangfolge fehlt sie — der Fixture-Bestand kann den Test rot machen', () => {
    // Was ein Weg ohne Sortierung einblenden wuerde: Lieferreihenfolge, Tor, die ersten drei.
    const tokens = torWoerter(FRAGE);
    const ohneRang = BESTAND
      .filter((l) => zaehleBelege(tokens, lektionsText(l as Record<string, unknown>).toLowerCase()) >= 2)
      .slice(0, 3)
      .map((l) => l.topic);
    expect(ohneRang).toHaveLength(3);
    expect(ohneRang).not.toContain(RICHTIG);
  });

  it('der Leser mischt die Spitze neu, wenn er antwortet', async () => {
    // Ein Leser, der die Docker-Lektion fuer die beste haelt, hebt sie nach vorn.
    const leser = (texte: string[]) => texte.map((t) => (t.startsWith('docker:layer-cache') ? 100 : 0));
    const aus = await runEinblendung(eingabe(FRAGE), { cfg: cfg('leser'), fetchFn: netz(leser), protokoll: false });
    const themen = themenImRahmen(aus);
    expect(themen).toContain('docker:layer-cache');
    expect(themen).toContain(RICHTIG);
  });

  it('haengt der Leser, bleibt die lokale Ordnung — Rueckfall statt nichts', async () => {
    const start = Date.now();
    const aus = await runEinblendung(eingabe(FRAGE), { cfg: cfg('haengt'), fetchFn: netz('haengt'), protokoll: false });
    // Leser-Zeitlimit 2500 ms, danach sofort die lokale Ordnung.
    expect(Date.now() - start).toBeLessThan(5000);
    expect(themenImRahmen(aus)[0]).toBe(RICHTIG);
  }, 15_000);

  it('ein Dankeschoen blendet nichts ein', async () => {
    expect(await runEinblendung(eingabe('danke, passt'), { cfg: cfg('danke'), fetchFn: netz('aus'), protokoll: false })).toBe('');
  });

  it('SessionStart liefert das Briefing, gerahmt', async () => {
    const aus = await runEinblendung(
      JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/repo' }),
      { cfg: cfg('sitzung'), fetchFn: netz('aus'), protokoll: false },
    );
    const ctx: string = JSON.parse(aus).hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`<${RAHMEN_ETIKETT}>`);
    expect(ctx).toContain('docker:layer-cache'); // hoechste Abrufzahl
  });
});

describe('Verdrahtung: der Installer liefert genau diesen Weg aus', () => {
  it('der installierte Hook laedt das Hook-Buendel (seit v5 ohne npx)', () => {
    const skript = buildUserPromptSubmitHook({ instanceId: 'i1' });
    expect(skript).toContain(`await import('./${HOOK_BUENDEL}')`);
    expect(skript).not.toContain(AMBIENT_CLI_SUBCOMMAND);
  });

  it('das Buendel (ambient-hook.ts) laeuft durch runEinblendung, nicht durch smart_recall', () => {
    const quelle = readFileSync(resolve(__dirname, '..', 'ambient-hook.ts'), 'utf8');
    expect(quelle).toContain('runEinblendung)(');
    expect(quelle).not.toContain("'smart_recall'");
    const start = readFileSync(resolve(__dirname, '..', 'ambient-hook-start.ts'), 'utf8');
    expect(start).toContain('hookHauptlauf(');
  });

  it('der alte Befehl ambient-recall ruft dieselbe Funktion wie das Buendel', () => {
    const quelle = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');
    const anfang = quelle.indexOf("process.argv[2] === 'ambient-recall'");
    expect(anfang).toBeGreaterThan(0);
    const ende = quelle.indexOf('process.argv[2] ===', anfang + 10);
    const block = quelle.slice(anfang, ende);
    expect(block).toContain('hookHauptlauf(');
    expect(block).not.toContain("'smart_recall'");
  });
});
