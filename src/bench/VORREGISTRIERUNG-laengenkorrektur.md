# Vorregistrierung: Längenkorrektur der Seltenheitsdeckung (30.08.2026)

Karte `evpcpv1oreo4`. Geschrieben **vor** dem ersten Formellauf — sonst ist
hinterher jede Formel plausibel.

## Der bewiesene Mechanismus (verlust-zerlegen.ts, PR #541)

245 von 624 verlorenen Antworten auf Hälfte A sterben an der
Seltenheitsdeckung. Dort ist der falsche Sieger im Median 663 Zeichen lang,
die richtige Antwort 306. Kontrollgruppe (text-Verluste): 421 gegen 444 —
kein Effekt. Lange Texte decken seltene Fragewörter zufällig ab; das
höchste Gewicht (1,3) belohnt das.

## Die Kandidaten-Formeln (alle VOR dem Lauf festgelegt)

BM25-Längennormierung auf der Treffersumme (Robertson):

    deckung_b = (Σ_getroffen g(w) / Σ g(w)) · 1 / (1 − b + b·W/avgW)

mit W = Zahl der Wortstämme des Textes, avgW = Mittel über den Bestand.
b ∈ {0.25, 0.5, 0.75, 1.0}. F0 = heutige Formel (Kontrolle, muss den
A/B-Stand reproduzieren).

## Erwartungen, festgelegt vor dem Start

1. **Sanity:** die nachgerechnete heutige Deckung stimmt mit der
   gespeicherten überein (max. Abweichung < 0,001) — sonst ist der ganze
   Messstand ungültig und NICHTS wird gefolgert.
2. Mindestens ein b hebt die **Findequote@3 auf A um ≥ 0,5 Punkte**.
3. Bei diesem b fällt **P@1 nicht um mehr als 0,5 Punkte**.
4. Die **245 Seltenheits-Verluste fallen um ≥ 20 %** (auf ≤ 196).

## Was ein Scheitern bedeutet

Tritt 2. nicht ein, ist die Längenverzerrung zwar real, aber nicht der
tragende Teil des Seltenheits-Verlusts — dann wandert der Verdacht zur
Streuung des Merkmals selbst (spreizeImTopf macht aus kleinen Unterschieden
volle Abstände). Auch das ist ein Ergebnis und kommt in die Karte.

## Danach

Das gewählte b wird auf Hälfte B GENAU EINMAL bestätigt. Erst nach der
Bestätigung wird die Formel Produktvorgabe (rangfolge.ts + Stellschraube).
