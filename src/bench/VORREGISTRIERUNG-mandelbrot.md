# Vorregistrierung: Zipf-Mandelbrot-Seltenheit (K3, Naturworkshop 4)

Geschrieben 31.08.2026, VOR der ersten Zahl. Karte sfxbkf8yfugz,
Auftrag .agent/_naturworkshop/verfahren-suche-4.md (K3, Mandelbrot 1953).

## Die These

Unsere Seltenheit nutzt die Standard-IDF-Kurve `log((N+1)/(df+1))`.
Mandelbrot 1953: Worthäufigkeit folgt nicht Zipf pur, sondern
`f ∝ 1/(rang+B)^a` — die SPITZE der Verteilung (häufige Wörter,
Formular-Töne) ist flacher, der Schwanz steiler als Zipf annimmt. Als
Gewichtskurve übersetzt: `wert(df) = [log((N+1)/(df+B))]^a`. B verschiebt,
a spreizt. Status quo ist exakt (B=1, a=1).

Verwandtschaft, offen benannt: Die Schablonen-Karte (nuryz7a1bb8z) wollte
die Verteilungs-Spitze durch STREICHEN vor dem Einbetten behandeln — am
31.08. widerlegt, weil bge-m3 Formular-Töne als Kontext NUTZT. K3 wirkt
dagegen im WORTSTATISTIK-Kanal (Seltenheitsklasse in rangfolge.ts), wo der
Mechanismus „Token-Masse erdrückt Seltenheitsmasse" GILT (Verlust-Zerlegung:
39 % der Verluste im seltenheit-Kanal).

## Der Aufbau

- Messwerkzeug: mandelbrot-messen.ts nach dem Muster der Längenkorrektur —
  Deckung je (Frage, Kandidat) aus den TEXTEN neu gerechnet, dann der
  AUSGELIEFERTE bewerteTopf. Die Kurve wird in die bestehende
  Seltenheit-Klasse INJIZIERT (eine deckung()-Logik, keine Kopie).
- Sanity-Tor (Pflicht vor jeder Auswertung): Die (B=1, a=1)-Kontrolle F0
  muss die GESPEICHERTEN Deckungen der Merkmale reproduzieren (größte
  Abweichung < 0,001, wie im Längenkorrektur-Muster) — sonst misst das
  Werkzeug etwas anderes und der Lauf ist ungültig. Verglichen wird
  RELATIV zu F0 im selben Topf-Messstand, nicht gegen Zahlen aus dem
  vollen Nominierungs-Lauf.
- Kandidaten, NUR auf Hälfte A (merkmale-fremd-A.jsonl, 1999 Fragen):
  B ∈ {5, 20, 100} bei a=1, und a ∈ {0,75, 1,25} bei B=1. Fünf Varianten,
  keine Nachschübe nach dem ersten Blick.
- Längenkorrektur (SELTENHEIT_LAENGE_B=1,0) bleibt AN und unverändert —
  sie ist Auslieferstand seit der B-Bestätigung.

## Erwartungen (vorab)

1. AUSSICHTSREICH ist eine Variante ab **+0,5 Punkten Findequote@3 auf A**
   gegenüber der Grundlinie, ohne P@1-Verlust über 0,3 Punkte.
2. Nur die BESTE aussichtsreiche Variante geht auf Hälfte B — genau EINMAL.
   BESTÄTIGT ab +0,5 @3 auch dort. Sonst WIDERLEGT, dokumentieren,
   nicht nachbessern.
3. Erreicht KEINE Variante die Schwelle auf A, ist K3 GEMESSEN_FALSCH für
   diesen Prüfsatz — B wird nicht angefasst, und das Urteil wandert in
   Protokoll und Karte. (Die Obergrenzen-Warnung des Auftrags: wenn
   bester_zeuge die Kurve schon dominiert, ändert die Kurvenform wenig.)

## Was NICHT passiert

Keine Kombination mit anderen Kandidaten (Einzelbau schlägt Verheiratung —
Workshop-3-Beleg), keine Gewichts-Nachjustierung im selben Lauf, keine
Änderung an eingefrorenen Sätzen.
