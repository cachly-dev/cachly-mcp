import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ersparteMinuten, istStarterLektion, fmtStunden, STARTER_THEMEN, zaehltAlsErsparnis } from '../wertbeitrag.js';
import { STARTER_CORPUS } from '../starter-corpus.js';

const quelle = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('Wertbeitrag — fremdes Wissen zaehlt nicht', () => {
  it('erkennt eine Starter-Lektion an source, nicht am Namen', () => {
    expect(istStarterLektion({ source: 'starter' })).toBe(true);
    expect(istStarterLektion({ source: 'git' })).toBe(false);
    expect(istStarterLektion({})).toBe(false);
    expect(istStarterLektion(null)).toBe(false);
  });

  it('gibt fuer Starter-Lektionen 0 Minuten, egal welche Schwere', () => {
    for (const sev of ['critical', 'major', 'minor', undefined]) {
      expect(ersparteMinuten({ source: 'starter', severity: sev })).toBe(0);
      expect(ersparteMinuten({ source: 'starter', severity: sev }, 'trace')).toBe(0);
    }
  });

  it('laesst die Staffel fuer eigene Lektionen unveraendert', () => {
    expect(ersparteMinuten({ severity: 'critical' })).toBe(240);
    expect(ersparteMinuten({ severity: 'major' })).toBe(60);
    expect(ersparteMinuten({ severity: 'minor' })).toBe(30);
    expect(ersparteMinuten({})).toBe(30);
  });

  it('behaelt die abweichende Staffel von causal_trace', () => {
    expect(ersparteMinuten({ severity: 'critical' }, 'trace')).toBe(240);
    expect(ersparteMinuten({ severity: 'major' }, 'trace')).toBe(120);
    expect(ersparteMinuten({ severity: 'minor' }, 'trace')).toBe(60);
  });

  // ── Die eigentliche Gegenprobe ────────────────────────────────────────────
  //
  // Naheliegend waere gewesen, die sechs auffaelligen Themen vom 17.08.2026
  // hart auszuschliessen. Dieser Test stellt sicher, dass es NICHT so gebaut
  // ist: Eine erfundene Starter-Lektion, die in keiner Namensliste stehen kann,
  // muss genauso 0 ergeben.
  it('wirkt auch fuer eine Starter-Lektion, die es heute noch gar nicht gibt', () => {
    const kuenftig = { topic: 'gibt-es-2027:noch-nicht', severity: 'critical', source: 'starter' };
    expect(ersparteMinuten(kuenftig)).toBe(0);
  });

  // Und die Gegenrichtung: Eine ECHTE Lektion mit demselben Themennamen wie
  // eine Starter-Lektion muss weiter zaehlen. Genau das ist der Normalfall —
  // der Startvorrat wird ersetzt, sobald jemand zum Thema etwas Eigenes lernt.
  it('zaehlt eine eigene Lektion, auch wenn das Thema aus dem Startvorrat stammt', () => {
    const eigen = { topic: 'docker:layer-cache', severity: 'major', source: 'git' };
    expect(ersparteMinuten(eigen)).toBe(60);
  });
});

/*
 * ── DIE LUECKE VOM 22.08.2026 ───────────────────────────────────────────────
 *
 * An dieser Stelle stand vorher eine Probe mit dem Namen
 *
 *     "der ausgelieferte Startvorrat traegt die Markierung wirklich"
 *
 * und dem Kommentar: "Wenn brain_seed_starter je aufhoert, source zu setzen,
 * faellt die ganze Regel still aus". Ihr Rumpf pruefte dann:
 *
 *     expect(STARTER_CORPUS.length).toBeGreaterThan(0);
 *     for (const l of STARTER_CORPUS) expect(typeof l.topic).toBe('string');
 *
 * Das Feld `source` kam darin nicht vor. Der Name versprach genau die
 * Zusicherung, die dann gefehlt hat; gepruefft wurde, ob ein Textfeld ein Text
 * ist. Fuenf Tage lang war das gruen, waehrend die groesste Einzelquelle der
 * Zahl ungefiltert durchlief.
 *
 * Die Proben unten pruefen deshalb nicht mehr die Absicht, sondern den Weg:
 * sie lesen aus dem Quelltext, WELCHE Herkunftswerte tatsaechlich geschrieben
 * werden, und schicken jeden davon durch die Funktion. Ein dritter Einbauweg
 * mit einem neuen Wert faellt damit auf, ohne dass jemand daran denken muss.
 */
describe('Wertbeitrag — jeder Einbauweg wird auch erkannt', () => {
  it('findet die Herkunftswerte, die beim Einbauen wirklich geschrieben werden', () => {
    const wege = [
      { datei: 'handlers/share.ts', was: 'brain_seed_starter' },
      { datei: 'handlers/team.ts', was: 'import_public_brain' },
    ];

    const gefunden = new Set<string>();
    for (const weg of wege) {
      const src = quelle(weg.datei);
      for (const m of src.matchAll(/source:\s*['"]([a-z_:]+)['"]/g)) {
        gefunden.add(m[1]!);
      }
      expect(gefunden.size, `${weg.was} schreibt gar keine Herkunft mehr`).toBeGreaterThan(0);
    }

    // Der Beweis, dass die Probe wirklich etwas sieht: die zwei bekannten
    // Werte muessen darunter sein. Fehlt einer, wurde umbenannt.
    expect(gefunden).toContain('starter');
    expect(gefunden).toContain('public_brain');
  });

  it('erkennt public_brain — die Luecke, die 1664 h auf 6445 h trieb', () => {
    // import_public_brain (team.ts:1610) schreibt source: 'public_brain'.
    // Der alte Filter verglich mit === 'starter' und liess das durch.
    expect(istStarterLektion({ source: 'public_brain', topic: 'docker:layer-cache' })).toBe(true);
    expect(ersparteMinuten({ source: 'public_brain', severity: 'major' })).toBe(0);
  });

  it('erkennt jede Herkunft, die irgendein Einbauweg schreibt', () => {
    // Diese Probe ist der eigentliche Waechter. Sie liest die Werte aus dem
    // Code und fragt die Funktion — nicht umgekehrt.
    const eingebaut = new Set<string>();
    for (const datei of ['handlers/share.ts', 'handlers/team.ts']) {
      const src = quelle(datei);
      for (const m of src.matchAll(/source:\s*['"]([a-z_:]+)['"]/g)) {
        const wert = m[1]!;
        // Nur die Wege, die FREMDES Wissen einbauen. 'ckg', 'git_commit',
        // 'ci_outcome' und 'lesson' sind eigene Arbeit und muessen zaehlen.
        if (/starter|public|marketplace|syndicate|import/.test(wert)) eingebaut.add(wert);
      }
    }
    expect(eingebaut.size, 'kein einziger Einbauweg gefunden — Regex tot?').toBeGreaterThan(1);
    for (const wert of eingebaut) {
      expect(istStarterLektion({ source: wert }), `Herkunft '${wert}' zaehlt faelschlich mit`).toBe(true);
    }
  });

  it('GEGENPROBE: eigene Herkuenfte zaehlen weiter', () => {
    // Wenn der Filter zu breit wird, verschwindet die echte Leistung aus der
    // Zahl — das waere derselbe Fehler in die andere Richtung.
    for (const eigen of ['git', 'git_commit', 'ci_outcome', 'lesson', 'ckg']) {
      expect(istStarterLektion({ source: eigen }), `eigene Herkunft '${eigen}' faelschlich entwertet`).toBe(false);
      expect(ersparteMinuten({ source: eigen, severity: 'major' })).toBe(60);
    }
  });
});

describe('Wertbeitrag — Lektionen ohne Herkunftsfeld', () => {
  // learn_from_attempts setzt `source` nicht. Fuer solche Lektionen entscheidet
  // Thema UND Wortlaut — nicht das Thema allein.
  it('entwertet einen wortgleichen Startvorrat-Eintrag ohne Herkunft', () => {
    const erste = STARTER_CORPUS[0]!;
    expect(istStarterLektion({ topic: erste.topic, what_worked: erste.what_worked })).toBe(true);
    expect(ersparteMinuten({ topic: erste.topic, what_worked: erste.what_worked, severity: 'critical' })).toBe(0);
  });

  it('GEGENPROBE: ein EIGENER Satz zum selben Thema zaehlt', () => {
    const erste = STARTER_CORPUS[0]!;
    const eigen = {
      topic: erste.topic,
      what_worked: 'Bei uns lag es am BuildKit-Cache-Mount, nicht an der Reihenfolge der COPY-Zeilen.',
      severity: 'major',
    };
    expect(istStarterLektion(eigen)).toBe(false);
    expect(ersparteMinuten(eigen)).toBe(60);
  });

  it('GEGENPROBE: ein unbekanntes Thema ohne Herkunft zaehlt', () => {
    expect(istStarterLektion({ topic: 'node1:portkollision', what_worked: 'irgendwas' })).toBe(false);
  });

  it('die Themenliste stammt aus dem Vorrat, nicht aus einer Abschrift', () => {
    // Der erste Versuch am 22.08. war eine handgetippte Liste: sieben Themen
    // fehlten, drei existierten gar nicht. Diese Probe haelt beide zusammen.
    expect(STARTER_THEMEN.size).toBe(STARTER_CORPUS.length);
    for (const l of STARTER_CORPUS) {
      expect(STARTER_THEMEN.has(l.topic), `Thema '${l.topic}' fehlt in STARTER_THEMEN`).toBe(true);
    }
  });
});

describe('fmtStunden', () => {
  it('rechnet Minuten in eine lesbare Angabe um', () => {
    expect(fmtStunden(0)).toBe('0 min');
    expect(fmtStunden(45)).toBe('45 min');
    expect(fmtStunden(60)).toBe('1 h');
    expect(fmtStunden(21 * 60)).toBe('21 h');
    expect(fmtStunden(24 * 60)).toBe('1 d');
    expect(fmtStunden(28 * 60)).toBe('1 d 4 h');
  });

  it('nimmt negative Werte nicht krumm', () => {
    expect(fmtStunden(-5)).toBe('0 min');
  });
});

/*
 * ── DER ZWEITE BEFUND: WIEDERHOLUNG WAR WERT ────────────────────────────────
 *
 * Der Startvorrat war nur die halbe Ursache. Die andere: jeder Abruf schrieb
 * die volle Recherchezeit erneut gut. `smart_recall` tat das fuer bis zu FUENF
 * Lektionen je Aufruf, und die Anleitung des Servers verlangt einen Aufruf vor
 * jeder Aufgabe.
 *
 * Gemessen am 22.08.2026: das Brain war 82 Tage alt und meldete 1664,5 h. Eine
 * Person haette in 82 Tagen zu acht Stunden 656 h gehabt. Nicht zu hoch —
 * unmoeglich.
 */
describe('Wertbeitrag — eine Lektion zaehlt genau einmal', () => {
  it('der erste Abruf zaehlt', () => {
    expect(zaehltAlsErsparnis({ severity: 'major', recall_count: 0 })).toBe(true);
    expect(zaehltAlsErsparnis({ severity: 'major' })).toBe(true); // Feld fehlt = noch nie
  });

  it('der zweite und jeder weitere zaehlt NICHT', () => {
    for (const n of [1, 2, 42, 980]) {
      expect(zaehltAlsErsparnis({ severity: 'critical', recall_count: n }),
        `Abruf Nr. ${n + 1} wurde erneut gutgeschrieben`).toBe(false);
    }
  });

  it('die Rechnung, die es unmoeglich machte, geht nicht mehr auf', () => {
    // docker:layer-cache stand am 22.08. bei 980 Abrufen. Alte Bauart:
    // 980 x 60 min = 980 h aus EINER Lektion. Neue Bauart: 0, weil Startvorrat
    // — und selbst als eigene Lektion nur einmal.
    const vielAbgerufen = { topic: 'docker:layer-cache', severity: 'major', source: 'starter', recall_count: 980 };
    expect(zaehltAlsErsparnis(vielAbgerufen)).toBe(false);

    const eigenVielAbgerufen = { topic: 'deploy:node1', severity: 'major', source: 'git', recall_count: 980 };
    expect(zaehltAlsErsparnis(eigenVielAbgerufen)).toBe(false);
    expect(zaehltAlsErsparnis({ ...eigenVielAbgerufen, recall_count: 0 })).toBe(true);
  });

  it('der Startvorrat zaehlt auch beim ERSTEN Abruf nicht', () => {
    expect(zaehltAlsErsparnis({ source: 'starter', recall_count: 0 })).toBe(false);
    expect(zaehltAlsErsparnis({ source: 'public_brain', recall_count: 0 })).toBe(false);
  });

  it('GEGENPROBE: die Obergrenze ist jetzt der Wissensstand, nicht die Nutzung', () => {
    // Der Sinn der Regel in einer Zahl: 500 eigene Lektionen, jede einmal
    // gezaehlt, koennen hoechstens 500 x 240 min ergeben — egal wie oft
    // jemand das Brain benutzt. Vorher gab es keine Obergrenze.
    const hoechstens = 500 * 240;
    let summe = 0;
    for (let i = 0; i < 500; i++) {
      const l = { severity: 'critical', source: 'git', recall_count: 0 };
      if (zaehltAlsErsparnis(l)) summe += ersparteMinuten(l);
      // dieselbe Lektion nochmal, hundertfach
      for (let k = 1; k <= 100; k++) {
        const wieder = { severity: 'critical', source: 'git', recall_count: k };
        if (zaehltAlsErsparnis(wieder)) summe += ersparteMinuten(wieder);
      }
    }
    expect(summe).toBe(hoechstens);
  });
});

describe('Wertbeitrag — die Aufrufer halten sich an die Regel', () => {
  // Diese Probe liest den Code, nicht die Absicht: keine Stelle darf die
  // Minuten ohne die Einmal-Pruefung buchen.
  const stellen = ['handlers/brain.ts', 'handlers/advanced.ts'];

  it('kein Aufrufer bucht ersparteMinuten ohne zaehltAlsErsparnis', () => {
    let geprueft = 0;
    for (const datei of stellen) {
      const src = quelle(datei);
      for (const m of src.matchAll(/const savedMins = ([^;]+);/g)) {
        geprueft++;
        expect(m[1], `${datei}: bucht ohne Einmal-Pruefung`).toContain('zaehltAlsErsparnis');
      }
    }
    expect(geprueft, 'keine einzige Buchungsstelle gefunden — Regex tot?').toBeGreaterThanOrEqual(3);
  });

  it('brain_hygiene rechnet NICHT mehr mal Abrufzahl', () => {
    const src = quelle('handlers/team.ts');
    expect(src, 'die Wiederholung ist wieder Wert').not.toContain('* ersparteMinuten(lesson)');
    expect(src).toContain('if ((lesson.recall_count ?? 0) > 0) minutenNeu += ersparteMinuten(lesson);');
  });
});

