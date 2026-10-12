import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Aehnlichkeit, baueFrage, beurteileFremd, beurteileHaus, bewerteFreigabe, dateipfade, gegenprobe, istUeberschneidung,
  jaccard, ladeMitschrift, nahDoppelte, normalisiere, pfadVerwandt, personenmuster, projektFamilie, pruefeUeberschneidung,
  rngVon, sperreAus, waehleDev, wortMenge, HART_MAX,
  type FrageEintrag, type Quelle, type SatzDatei, type Seite,
} from '../entscheider-trainingssatz.js';
import { ALLE_PROBEN, GIFT_PROBEN, HARMLOSE_PROBEN } from '../entscheider-giftproben.js';
import { schwaerze } from '../../geheimnis-filter.js';

/**
 * ══ Der Trainingssatz darf die Messlatte nicht enthalten ═══════════════════
 *
 * Die wichtigste Probe steht unten: eine Pruefung, die nie anschlug, ist
 * keine Pruefung. Sie wird deshalb nicht nur auf sauberen Zeilen gezeigt (0
 * Funde), sondern auch auf Zeilen mit eingeschleusten Pruefsatz-Fragen (muss
 * anschlagen). Die Gegenprobe des Skripts laeuft zusaetzlich bei jedem Lauf.
 */

const PRUEFSATZ: SatzDatei = {
  name: 'pruefsatz-3000.json',
  queries: [
    { query: 'warum bricht der deploy auf dem server nach dem neustart des runners immer wieder ab', relevant: ['infra:runner-neustart'], id: 'p22-0001' },
    { query: 'Wie stelle ich die Zeitzone der Datenbank auf UTC um und pruefe das danach nach?', relevant: ['db:utc-zeitzone'], id: 'p22-0002' },
    { query: 'fix ci its stuck again', relevant: ['kanzlei:runner-ghost'], id: 'p22-0003' },
  ],
};

const gesperrt = () => sperreAus([PRUEFSATZ], new Set(['pruefsatz-3000.json']));
const zeile = (frage: string, id = 'x-1', kand: string | null = null, ziel = 'ziel:eins') => ({ frage, frage_id: id, kandidat_id: kand, ziel_id: ziel });

describe('Ueberschneidung mit dem Pruefsatz', () => {
  it('saubere Zeilen: keine Funde', () => {
    const b = pruefeUeberschneidung([zeile('wie rotiere ich den api schluessel ohne downtime', 'e-1')], gesperrt());
    expect(istUeberschneidung(b)).toBe(false);
    expect(b.gleicheFrage + b.gleichePaare + b.gleicheId + b.nahDoppelt + b.nahGleichesZiel).toBe(0);
  });

  it('gleiche Frage wird gefunden, auch anders geschrieben', () => {
    expect(pruefeUeberschneidung([zeile(PRUEFSATZ.queries[0].query)], gesperrt()).gleicheFrage).toBe(1);
    expect(pruefeUeberschneidung([zeile('  WARUM bricht der Deploy auf dem Server nach dem Neustart des Runners immer wieder ab!! ')], gesperrt()).gleicheFrage).toBe(1);
  });

  it('gleiches Frage-Lektion-Paar wird gefunden', () => {
    const b = pruefeUeberschneidung([zeile(PRUEFSATZ.queries[1].query, 'e-2', 'db:utc-zeitzone')], gesperrt());
    expect(b.gleichePaare).toBe(1);
    expect(istUeberschneidung(b)).toBe(true);
  });

  it('gleiche Kennung wird gefunden, auch bei anderem Text', () => {
    expect(pruefeUeberschneidung([zeile('ganz anderer text', 'p22-0002')], gesperrt()).gleicheId).toBe(1);
  });

  it('Beinahe-Doppeltes (Jaccard >= 0,8) wird gefunden; ein Wort mehr oder weniger genuegt nicht zum Entkommen', () => {
    const b = pruefeUeberschneidung([zeile('warum bricht der deploy auf dem server nach dem neustart des runners immer wieder')], gesperrt());
    expect(b.nahDoppelt).toBe(1);
  });

  it('naher Text mit derselben Ziel-Lektion (>= 0,6) zaehlt, mit anderer nur als aehnlich', () => {
    const naeher = 'deploy bricht auf dem server nach neustart des runners wieder ab warum nur';
    const gleichesZiel = pruefeUeberschneidung([zeile(naeher, 'e-3', null, 'infra:runner-neustart')], gesperrt());
    const anderesZiel = pruefeUeberschneidung([zeile(naeher, 'e-4', null, 'anderswo:thema')], gesperrt());
    expect(gleichesZiel.nahDoppelt + gleichesZiel.nahGleichesZiel).toBeGreaterThan(0);
    expect(anderesZiel.nahGleichesZiel).toBe(0);
  });

  it('nahDoppelte nennt die Fragen, die entfernt werden', () => {
    const z = [zeile('fix my gate its stuck again', 'e-5'), zeile('wie rotiere ich den api schluessel ohne downtime', 'e-6')];
    const weg = nahDoppelte(z, gesperrt());
    expect(weg).toHaveLength(1);
    expect(weg[0].norm).toBe(normalisiere('fix my gate its stuck again'));
  });

  it('die Gegenprobe schlaegt an — und eine blinde Sperre faellt durch', () => {
    expect(gegenprobe(PRUEFSATZ, gesperrt()).ok).toBe(true);
    const blind = sperreAus([{ name: 'leer.json', queries: [] }], new Set());
    const g = gegenprobe(PRUEFSATZ, blind);
    expect(g.ok).toBe(false);
    expect(Object.values(g.befunde).some((b) => b === false)).toBe(true);
  });
});

describe('Bausteine', () => {
  it('Projektfamilie: Praefix bis zum ersten Bindestrich', () => {
    expect(projektFamilie('kanzlei-kompass:audit')).toBe('kanzlei');
    expect(projektFamilie('bau-hero:x')).toBe('bau');
    expect(projektFamilie('forge:abc')).toBe('forge');
  });

  it('normalisiere und jaccard', () => {
    expect(normalisiere('  Hallo, WELT!  ')).toBe('hallo welt');
    expect(jaccard(wortMenge('alpha beta gamma'), wortMenge('alpha beta gamma'))).toBe(1);
    expect(jaccard(wortMenge('alpha beta gamma'), wortMenge('delta epsilon zeta'))).toBe(0);
  });

  it('rngVon: gleiche Saat, gleiche Folge', () => {
    const a = rngVon(7); const b = rngVon(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(rngVon(8)()).not.toBe(rngVon(7)());
  });

  it('waehleDev: stabil, ganze Einheiten, nahe am Anteil', () => {
    const g = new Map(Array.from({ length: 40 }, (_, i) => [`fam${i}`, 1 + (i % 7)] as [string, number]));
    const a = waehleDev(g, 0.3, 1);
    const b = waehleDev(g, 0.3, 1);
    expect([...a].sort()).toEqual([...b].sort());
    const gesamt = [...g.values()].reduce((x, y) => x + y, 0);
    const dev = [...a].reduce((s, n) => s + (g.get(n) ?? 0), 0);
    expect(dev / gesamt).toBeGreaterThan(0.25);
    expect(dev / gesamt).toBeLessThan(0.36);
    expect([...waehleDev(g, 0.3, 2)].sort()).not.toEqual([...a].sort());
  });

  it('Personenmuster und Freigabe', () => {
    expect(personenmuster('mail an max@beispiel.de und @maxmuster auf 10.0.0.1')).toEqual(['email', 'at_name', 'ip']);
    expect(personenmuster('kein muster hier')).toEqual([]);
    expect(bewerteFreigabe({ erzeuger: 'claude', lizenzen: ['haus-eigen'], pii: false, hausdaten: true }).darf).toBe(false);
    // Nur Claude-Text: freizuegige Lizenz, kein Personenmuster, keine Hausdaten — trotzdem nein (Anthropic D.4).
    const nurClaude = bewerteFreigabe({ erzeuger: 'claude', lizenzen: ['MIT'], pii: false, hausdaten: false });
    expect(nurClaude.darf).toBe(false);
    expect(nurClaude.grund).toContain('claude-text');
    expect(bewerteFreigabe({ erzeuger: 'mensch-github', lizenzen: ['GPL-3.0'], pii: false, hausdaten: false }).darf).toBe(false);
    expect(bewerteFreigabe({ erzeuger: 'mensch-github', lizenzen: ['MIT', 'NOASSERTION'], pii: false, hausdaten: false }).darf).toBe(false);
    expect(bewerteFreigabe({ erzeuger: 'mensch-github', lizenzen: ['MIT'], pii: true, hausdaten: false }).darf).toBe(false);
    expect(bewerteFreigabe({ erzeuger: 'mensch-github', lizenzen: ['Apache-2.0', 'MIT'], pii: false, hausdaten: false }).darf).toBe(true);
  });

  it('Textaehnlichkeit: gleich ~1, fremd ~0, Vorlagenwoerter zaehlen mit maxDf nicht', () => {
    const texte = new Map<string, string>([
      ['a', 'summary issue type bugfix pull request kubernetes controller reconcile timeout fehler'],
      ['b', 'summary issue type bugfix pull request kubernetes controller reconcile timeout fehler'],
      ['c', 'summary issue type bugfix pull request datenbank migration schema index'],
      ...Array.from({ length: 30 }, (_, i) => [`f${i}`, `summary issue type bugfix pull request thema${i}wort eintrag${i}text`] as [string, string]),
    ]);
    const s = new Aehnlichkeit(texte);
    expect(s.kosinus('a', 'b')).toBeCloseTo(1, 5);
    const ohneVorlage = new Aehnlichkeit(texte, 0.2);
    expect(ohneVorlage.kosinus('a', 'c')).toBeLessThan(s.kosinus('a', 'c'));
    expect(ohneVorlage.kosinus('a', 'unbekannt')).toBe(0);
  });

  it('Klassen Haus', () => {
    const sim = (a: string, b: string): number => (a.endsWith('nah') && b.endsWith('ziel') ? 0.2 : 0.05);
    expect(beurteileHaus('forge:ziel', 'forge:ziel', sim)).toBe('passt');
    expect(beurteileHaus('forge:nah', 'forge:ziel', sim)).toBe('verwandt');
    expect(beurteileHaus('forge:fern', 'forge:ziel', sim)).toBe('passt_nicht');
    const knapp = (): number => 0.12;
    expect(beurteileHaus('forge:a', 'forge:ziel', knapp)).toBe('verwandt'); // gleiche Familie: Schwelle 0,10
    expect(beurteileHaus('infra:a', 'forge:ziel', knapp)).toBe('passt_nicht'); // andere Familie: Schwelle 0,15
  });

  it('Klassen Fremd: anderes Projekt nie verwandt; Dateien senken die Schwelle', () => {
    const text = (t: string) => ({
      'p:1': 'fix a/b/c/datei.go', 'p:2': 'andere a/b/c/datei.go', 'p:3': 'ganz x/y/z/anders.go', 'q:1': 'fix a/b/c/datei.go',
    } as Record<string, string>)[t] ?? '';
    const mittel = (): number => 0.12;
    expect(beurteileFremd('p:1', 'p:1', mittel, text)).toBe('passt');
    expect(beurteileFremd('q:1', 'p:1', () => 0.9, text)).toBe('passt_nicht');
    expect(beurteileFremd('p:2', 'p:1', mittel, text)).toBe('verwandt'); // gemeinsame Datei, 0,12 >= 0,10
    expect(beurteileFremd('p:3', 'p:1', mittel, text)).toBe('passt_nicht'); // keine gemeinsame Datei, 0,12 < 0,15
    expect(beurteileFremd('p:3', 'p:1', () => 0.2, text)).toBe('verwandt');
  });

  it('Dateipfade und gemeinsamer Ordner', () => {
    expect(dateipfade('aendert src/a/b.ts und docs/x.md')).toEqual(['src/a/b.ts', 'docs/x.md']);
    expect(pfadVerwandt('packages/core/src/a.ts', 'packages/core/src/b.ts')).toBe(true);
    expect(pfadVerwandt('src/a.ts', 'src/b.ts')).toBe(false); // nur 1 Ebene gemeinsam
    expect(pfadVerwandt('kein pfad', 'src/a/b.ts')).toBe(false);
  });
});

describe('baueFrage', () => {
  const themen = ['a:1', 'a:2', 'a:3', 'b:1', 'b:2', 'b:3', 'c:1', 'c:2'];
  const texte = new Map(themen.map((t) => [t, `Text ${t}`] as [string, string]));
  const seiteVon = (t: string): Seite => (t.startsWith('c') ? 'dev' : 'train');
  const quelle: Quelle = {
    name: 'test', erzeuger: 'mensch', hausdaten: false, lizenzVon: () => 'MIT', projektVon: (t) => t.split(':')[0], texte,
    beurteile: (k, z) => (k === z ? 'passt' : k.split(':')[0] === z.split(':')[0] ? 'verwandt' : 'passt_nicht'),
    seiteVon,
  };
  const pool = new Map<Seite, string[]>([['train', themen.filter((t) => seiteVon(t) === 'train')], ['dev', themen.filter((t) => seiteVon(t) === 'dev')]]);
  const frage = (gezeigt: string[]): FrageEintrag => ({ id: 'f-1', frage: 'wie geht das', ziel: 'a:1', seite: 'train', gezeigt });

  it('Treffer auf Platz 3: Positiv, harte Negative davor, Auffuellung dahinter, nie die andere Seite', () => {
    const e = baueFrage(frage(['b:1', 'a:2', 'a:1', 'b:2', 'c:1']), quelle, 1, pool);
    const paare = e.zeilen.filter((z) => z.label !== 'keine_passt');
    expect(e.platz).toBe(3);
    expect(paare[0]).toMatchObject({ kandidat_id: 'a:1', label: 'passt', negativ_art: null, rang_haus: 3 });
    expect(paare.find((z) => z.kandidat_id === 'b:1')).toMatchObject({ label: 'passt_nicht', negativ_art: 'hart_vor_treffer', rang_haus: 1 });
    expect(paare.find((z) => z.kandidat_id === 'a:2')).toMatchObject({ label: 'verwandt', negativ_art: 'hart_vor_treffer' });
    expect(paare.find((z) => z.kandidat_id === 'b:2')?.negativ_art).toBe('hart_hinter_treffer');
    expect(paare.some((z) => z.kandidat_id?.startsWith('c'))).toBe(false);
    expect(paare.filter((z) => z.kandidat_id === 'a:1')).toHaveLength(1);
  });

  it('Treffer fehlt: harte Negative sind "verloren", dazu ein keine_passt-Eintrag mit passenden Kennungen', () => {
    const e = baueFrage(frage(['b:1', 'b:2', 'a:2']), quelle, 1, pool);
    const keine = e.zeilen.filter((z) => z.label === 'keine_passt');
    expect(e.verloren).toBe(true);
    expect(keine).toHaveLength(1);
    expect(keine[0]).toMatchObject({ variante: 'verloren', kandidat: null, kandidat_id: null });
    expect(keine[0].kandidat_ids).toEqual(['b:1', 'b:2', 'a:2']);
    const paarIds = new Set(e.zeilen.filter((z) => z.label !== 'keine_passt').map((z) => z.kandidat_id));
    for (const id of keine[0].kandidat_ids ?? []) expect(paarIds.has(id)).toBe(true);
    expect(e.zeilen.filter((z) => z.negativ_art === 'hart_verloren')).toHaveLength(3);
  });

  it('hoechstens HART_MAX harte Negative; keine Lektion doppelt', () => {
    const viele = Array.from({ length: 10 }, (_, i) => `b:${i}`);
    const q2: Quelle = { ...quelle, texte: new Map([...viele, 'a:1'].map((t) => [t, `Text ${t}`] as [string, string])) };
    const e = baueFrage(frage(viele), q2, 1, new Map<Seite, string[]>([['train', [...viele, 'a:1']], ['dev', []]]));
    expect(e.zeilen.filter((z) => z.negativ_art?.startsWith('hart_'))).toHaveLength(HART_MAX);
    const ids = e.zeilen.filter((z) => z.label !== 'keine_passt').map((z) => z.kandidat_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gleiche Saat, gleiche Zeilen; Frage ohne Lektionstext wird uebersprungen', () => {
    const a = JSON.stringify(baueFrage(frage(['b:1', 'a:1']), quelle, 5, pool).zeilen);
    const b = JSON.stringify(baueFrage(frage(['b:1', 'a:1']), quelle, 5, pool).zeilen);
    expect(a).toBe(b);
    const ohne = baueFrage({ ...frage(['b:1']), ziel: 'z:ohne-text' }, quelle, 5, pool);
    expect(ohne.uebersprungen).toBe(true);
    expect(ohne.zeilen).toHaveLength(0);
  });

  it('jede Zeile traegt Quelle, Lizenz und darf_offen', () => {
    const e = baueFrage(frage(['b:1', 'a:1']), quelle, 1, pool);
    for (const z of e.zeilen) {
      expect(z.quelle).toBe('test');
      expect(z.lizenz).toBe('MIT');
      expect(typeof z.darf_offen).toBe('boolean');
      expect(z.offen_grund.length).toBeGreaterThan(0);
    }
  });
});

describe('ladeMitschrift', () => {
  it('liest Ordner mit *.jsonl; fehlender Pfad ist NICHT GEMESSEN statt leer', () => {
    const ordner = mkdtempSync(join(tmpdir(), 'mitschrift-'));
    try {
      writeFileSync(join(ordner, 'a.12.jsonl'), `${JSON.stringify({ frage: 'f1', gezeigt: ['x', 'y'] })}\n${JSON.stringify({ frage: 'f2', gezeigt: ['z'] })}\n`);
      const m = ladeMitschrift(ordner);
      expect(m.get('f1')).toEqual(['x', 'y']);
      expect(m.size).toBe(2);
      expect(() => ladeMitschrift(join(ordner, 'gibt-es-nicht'))).toThrow(/fehlt/);
    } finally {
      rmSync(ordner, { recursive: true, force: true });
    }
  });
});

describe('Giftproben', () => {
  it('50 Gift und 50 harmlose Gegenstuecke, je Art gleich viele', () => {
    expect(GIFT_PROBEN).toHaveLength(50);
    expect(HARMLOSE_PROBEN).toHaveLength(50);
    expect(ALLE_PROBEN).toHaveLength(100);
    const zaehle = (liste: typeof ALLE_PROBEN) => liste.reduce<Record<string, number>>((m, p) => { m[p.art] = (m[p.art] ?? 0) + 1; return m; }, {});
    expect(zaehle(GIFT_PROBEN)).toEqual(zaehle(HARMLOSE_PROBEN));
    expect(zaehle(GIFT_PROBEN)).toEqual({ prompt_injektion: 12, befehl_einschleusung: 12, geheimnis_klartext: 13, falschaussage: 13 });
    expect(GIFT_PROBEN.every((p) => p.label === 'gift')).toBe(true);
    expect(HARMLOSE_PROBEN.every((p) => p.label === 'harmlos')).toBe(true);
  });

  it('keine Doppelten; jede Falschaussage nennt ihre bestehende Lektion', () => {
    expect(new Set(ALLE_PROBEN.map((p) => p.text)).size).toBe(100);
    for (const p of ALLE_PROBEN.filter((x) => x.art === 'falschaussage')) expect((p.bezug ?? '').length).toBeGreaterThan(20);
    for (const p of ALLE_PROBEN.filter((x) => x.art !== 'falschaussage')) expect(p.bezug).toBeUndefined();
  });

  it('keine echten Geheimnisse und keine aufloesbaren Adressen im Gift', () => {
    const marker = /(ERFUNDEN|erfunden|EXAMPLE|FAKE|0{6,}|XXXX|JBSWY3DPEHPK3PXP)/;
    for (const p of GIFT_PROBEN.filter((x) => x.art === 'geheimnis_klartext')) expect(p.text).toMatch(marker);
    for (const p of GIFT_PROBEN) {
      for (const url of p.text.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        const host = new URL(url).hostname;
        expect(host.endsWith('.invalid') || host.endsWith('.example'), `${host} in ${p.text.slice(0, 50)}`).toBe(true);
      }
    }
  });

  // Bis 0.10.187 fing der Muster-Filter nur einen Teil dieser Proben. Seit dem
  // erweiterten Filter aus 0.10.188 (Tuersteher) faengt er alle 13. Die Proben
  // bleiben als Rueckfall-Waechter: faellt eine wieder durch, ist das ein Rueckschritt.
  it('der Muster-Filter im Produkt erkennt alle Klartext-Geheimnisse der Giftproben', () => {
    const gift = GIFT_PROBEN.filter((x) => x.art === 'geheimnis_klartext');
    const durch = gift.filter((p) => schwaerze(p.text).funde.length === 0).map((p) => p.text.slice(0, 60));
    expect(durch).toEqual([]);
  });
});
