// Der notice-Kanal: die Zusicherungen, die nur ein Test halten kann.
//
// Warum es diesen Test gibt: der Kanal erreicht JEDEN Nutzer direkt in seinem
// Editor, und er hat genau zwei Arten zu versagen. Entweder er schweigt, wenn
// er reden sollte — dann ist er wertlos. Oder er redet bei jedem Prompt, und
// dann ist er nach einem Tag unsichtbar geworden, weil niemand ihn mehr liest.
//
// Vorbild ist der Upgrade-Hinweis (GROW-002): der wurde einmal versehentlich
// an smart_recall gehaengt und haette mit Ambient Recall bei jedem Prompt
// gefeuert. Genau diese Falle wird hier festgenagelt.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const quelle = readFileSync(new URL('../handlers/brain.ts', import.meta.url), 'utf8');

describe('notice-Kanal: von der API bis in die Sitzung', () => {
  it('liest das notice-Feld aus der API-Antwort', () => {
    expect(quelle).toMatch(/notice\?:\s*string/);
    expect(quelle).toMatch(/notice:\s*mem\?\.notice/);
  });

  it('wird an GENAU EINER Stelle ausgegeben — nicht an zwei', () => {
    // KORREKTUR der ersten Fassung dieses Tests: dort stand
    // match(/recallGate\.notice/) === 1. Das ist die falsche Frage, denn im
    // selben Block steht der Wert zweimal — einmal in der Bedingung, einmal in
    // der Ausgabe. Gezaehlt werden muss die AUSGABE, nicht die Erwaehnung.
    const ausgaben = (quelle.match(/lines\.push\(recallGate\.notice/g) ?? []).length;
    expect(ausgaben).toBe(1);
  });

  it('merkt sich je Instanz, dass es schon gezeigt wurde', () => {
    // Ohne diese Sperre erscheint der Hinweis bei jedem session_start — mit
    // Ambient Recall also bei jedem Prompt.
    expect(quelle).toMatch(/_noticeGezeigt\s*=\s*new Set<string>\(\)/);
    expect(quelle).toMatch(/_noticeGezeigt\.has\(instance_id\)/);
    expect(quelle).toMatch(/_noticeGezeigt\.add\(instance_id\)/);
  });

  it('haengt im SITZUNGSBRIEFING, nicht in smart_recall', () => {
    // Verankert an einer Zeichenkette, die es nur im Briefing gibt. Die erste
    // Fassung des Upgrade-Hinweis-Tests hat hier den falschen Anker erwischt
    // und den Hinweis dadurch in smart_recall gezwungen.
    const anker = quelle.indexOf('total** (time not re-researching known fixes)');
    const stelle = quelle.indexOf('recallGate.notice');
    expect(anker).toBeGreaterThan(-1);
    expect(stelle).toBeGreaterThan(-1);
    expect(Math.abs(stelle - anker)).toBeLessThan(2000);
  });

  it('wird nur ausgegeben, wenn die API wirklich etwas geschickt hat', () => {
    // Kein Ersatztext im Client. Was der Nutzer liest, kommt aus der API —
    // sonst haetten wir zwei Quellen fuer denselben Satz.
    expect(quelle).toMatch(/if \(recallGate\.notice && !_noticeGezeigt/);
    expect(quelle).not.toMatch(/notice\s*\?\?\s*['"`]/);
  });

  it('der Wert wird nirgends im Client umformuliert', () => {
    // Er wird gepusht wie er kommt. Ein Client, der den Text umbaut, ist die
    // zweite Wahrheit — dann steht in der API etwas anderes als beim Nutzer.
    expect(quelle).toMatch(/lines\.push\(recallGate\.notice, ''\)/);
  });
});
