# Vorregistrierung: Gegenauslese als Kriterium, A/B (31.08.2026)

Karte `op7ucs58m5mp`. Geschrieben **vor** dem Messlauf — sonst ist hinterher
jedes Lambda plausibel.

## Der Kandidat

Naturworkshop v1 „Negative Auslese im Thymus" (Lauf 21.08.2026, Ausgang
`tragfaehig`, seither ungemessen). Je Lektion wird EINMAL ein fester Satz von
drei Gegenfragen bestimmt: die drei naechsten FREMDEN Tueren (die Fragen, bei
denen sie faelschlich anspringen wuerde). Im Ranking wird die gespreizte Naehe
der Frage zur naechsten Gegenfrage mit Gewicht lambda abgezogen.

Werkzeug: `src/bench/gegenauslese-messen.ts` (Selbstprobe gruen am 31.08.).
Die Fassung von heute stellt die Messdisziplin richtig: der Lambda-Sweep der
ersten Fassung lief auf dem PRUEFSATZ — eingestellt wird jetzt auf A,
bestaetigt EINMAL auf B.

## Der Messstand (eingefroren)

| Was | Datei | Umfang |
|---|---|---|
| Korpus | `~/.cachly/bench-korpus/korpus-gross.json` | 499 Lektionen |
| Haelfte A (einstellen) | `einstellsatz-3000.json` | 2997 Fragen, SHA-256 `ef6408d1…baa362` |
| Haelfte B (bestaetigen) | `pruefsatz-3000.json` | 3003 Fragen, SHA-256 `d1e47b00…d8ef8` |
| Tueren | `eingaenge-ab.json` | 4006 (alle sechs Arten — der Stand, an dem auch Fragenschatten gemessen wurde) |
| Vektoren | `pool-vektoren.json` | 10 147 Schluessel |

Grundlinie zum Abgleich (Fragenschatten-Messung, 22.08.): @3 ≈ 64 %,
Decke ≈ 87 % auf n=3003.

## Verfahren, festgelegt vor dem Start

1. lambda ∈ {0.15, 0.3, 0.5, 0.8} laeuft NUR auf Haelfte A; gewaehlt wird
   das beste @3.
2. Das gewaehlte lambda laeuft GENAU EINMAL auf Haelfte B — zusammen mit der
   Zufallskontrolle (gleich viele Gegenfragen, zufaellig gewaehlt, gleiches
   lambda).
3. Gemeldet werden IMMER Platz 1 UND @3 (Spitze und Breite sind getrennte
   Mengen — Dreier-Serie vom 27.08.: was @1 hebt, hebt @3 nicht).

## Urteilskriterien (Workshop-Widerlegung, unveraendert uebernommen)

- **WIDERLEGT**, wenn @3 auf BEIDEN Haelften um weniger als 2 Punkte steigt.
- **WIDERLEGT ueber die Decke**, wenn der Abzug die Decke auf B um mehr als
  1 Punkt senkt (gegen den eigenen Ausgangswert, nicht gegen die alten 95 %).
- **NICHT BELEGT**, wenn die Zufallskontrolle auf B mindestens (Effekt − 0,5)
  erreicht — dann wirkt ein Abzug, nicht die AUSLESE.
- **NICHT GEMESSEN**, wenn der Bestaetigungslauf null Abzuege zaehlt.

## Bekannte Vorbefunde, die die Erwartung setzen

- Die billige Naeherung (Marge gegen den besten Fremden, je Frage) fiel:
  @3 56/61 gegen 58/63 im Auslieferstand.
- Kleinmessung aus der Dreier-Serie: Gegenauslese **+3 @1 / 0 @3** — und
  Kleinmessungen haben zuletzt zweimal mehr versprochen, als der grosse Satz
  bestaetigte (Seltenheits-Kanal, Fragenschatten-100er).

Erwartung daher, ehrlich benannt: vermutlich WIDERLEGT fuer @3. Ein
belegter @1-Gewinn ohne @3-Verlust waere ein eigener Befund fuer die Karte,
aber nach Workshop-Kriterium KEIN Auslieferungsgrund.

## Danach

- WIDERLEGT/NICHT BELEGT → Befund in die Karte und ins Brain, Kandidat
  benannt und NICHT ausgeliefert. Damit ist die Kandidatenliste der
  Designrunde leer gemessen.
- NICHT WIDERLEGT → Verdrahtung ERST nach dem vollen Bench mit Floors
  (41/55/71/97 + LoCoMo) — Messstand ist nicht Auslieferstand.
