/**
 * Ein Thema, das nur eine Kategorie ist: "code:", "deploy:", "auth:".
 *
 * Solche Lektionen sind kein Wissen, sondern Reste. Die VS-Code-Erweiterung schlug beim
 * Ambient Learning nur die Kategorie vor, und "Save" speicherte darunter ein Stueck Code.
 * Jede neue Lektion ueberschrieb die vorige (im eigenen Brain trug `code:` 8 Fassungen) und
 * sammelte dabei Abrufe — bis sie als "Proven Law" ganz oben im Briefing stand (14.10.2026).
 * Seit PR #800 gibt die API einem blossen Thema beim Speichern einen Namen; die alten Reste
 * bleiben im Bestand und werden hier erkannt.
 *
 * Eine Regel fuer Prompt-Einblendung (einblendung.ts) und Sitzungsbriefing (handlers/brain.ts).
 */
export function istBlossesThema(topic: string): boolean {
  return /^[a-z]+:?$/.test(topic);
}
