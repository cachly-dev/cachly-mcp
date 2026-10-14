/**
 * ══ Die Stellschrauben der Rangfolge — an EINEM Ort ═══════════════════════
 *
 * ── Warum es diese Datei gibt (23.08.2026) ───────────────────────────────
 *
 * Drei Zahlen standen doppelt: einmal im ausgelieferten Pfad
 * (`handlers/brain.ts`), einmal im Messstand (`bench/echter-korpus.ts`) und
 * teils noch in drei weiteren Messwerkzeugen.
 *
 *     SINN_TOPF                75   ->  bench: const POOL = 75
 *     EINGANG_SCHWELLE         0.5  ->  bench: const EINGANG_SCHWELLE = 0.5
 *     EINGANG_SORTIER_GEWICHT  0.2  ->  bench: gewicht: 0.2
 *
 * Der Messstand baut die Sortierung nach, statt sie aufzurufen. Das ist
 * bekannt — die Kommentare dort warnen an drei Stellen ausdruecklich davor:
 *
 *     "Der Bench muss das spiegeln, sonst misst er eine andere Suchmaschine
 *      als die ausgelieferte."
 *     "Wer ihn hier aufnimmt, ohne ihn dort einzubauen, misst wieder eine
 *      andere Suchmaschine als die ausgelieferte."
 *
 * Zwei Quellen, die von Hand gleichgehalten werden, gehen irgendwann
 * auseinander. Genau das ist am 20.08.2026 schon einmal passiert: der
 * Messstand sortierte mit `bewerteTopf`, der ausgelieferte Pfad mit
 * `mischeRangfolgen` (RRF). Die Fehlertext-Eingaenge brachten im Messstand
 * +6 Punkte, im Produkt +1. Die Zahl im Ergebnisdokument war richtig — sie
 * beschrieb nur eine Suchmaschine, die es nicht gab.
 *
 * Diese Datei nimmt der Disziplin die Arbeit ab. Wer eine Zahl aendert,
 * aendert sie hier, und beide Seiten ziehen mit. Die Probe
 * `stellschrauben-stehen-nur-hier.test.ts` haelt fest, dass niemand sie
 * wieder abschreibt.
 *
 * Die BEGRUENDUNG jeder Zahl bleibt dort, wo sie hingehoert: bei den
 * Messungen in `handlers/brain.ts`. Hier steht der Wert, dort steht warum.
 */

/**
 * Wie viele Themen der Bedeutungsabgleich in die engere Wahl nimmt.
 *
 * 75 — und ein Messstand mit anderem Topf misst eine andere Suchmaschine
 * (Naturworkshop 2: mit Bench-Vorgabe 25 statt der echten 75 war die
 * vermeintliche Vorauswahl-Luecke zu zwei Dritteln eingebildet).
 */
export const SINN_TOPF = 75;

/**
 * Ab welcher Naehe eine Fehlertext-Tuer ueberhaupt mitzaehlt.
 *
 * Darunter meldet sie "kein Wert" (−2) statt "schlechter Wert". Der
 * Unterschied ist der ganze gemessene Schaden gewesen, nicht die Idee —
 * Begruendung mit Zahlen in `handlers/brain.ts` ueber dem Tuer-Block.
 *
 * Seit `spreizeImTopf` Luecken neutral behandelt (Karte azmqezaxx2kx) ist
 * diese Schwelle nicht mehr die einzige Absicherung. Sie bleibt, weil eine
 * Tuer unterhalb 0,5 auch als Wert nichts taugt — gemessen, nicht vermutet.
 */
export const EINGANG_SCHWELLE = 0.5;

/**
 * Wie stark die Tuer mitsortiert.
 *
 * 0,7 seit dem 24.08. (Anhebung von 0,2 in der Messstand-Serie zu Karte
 * azmqezaxx2kx: Untergrenzen 41/55/71/97 gehalten). Der alte Satz "0,2 liegt
 * mittig im Band" beschrieb die Abtastung VOR dieser Anhebung
 * (`bench/schwelle-abtasten.ts`) und stand hier zwei Tage lang neben dem
 * neuen Wert — genau die Drift-Klasse, die Kommentare zu Zahlen befaellt:
 * Wer eine Stellschraube dreht, dreht den Satz darueber MIT.
 */
export const EINGANG_SORTIER_GEWICHT = 0.7;

/**
 * ── Das Zweitmerkmal: ein zweites Embedding als unabhaengiger Zeuge ────────
 *
 * Dreifach bestaetigt am 01.09.2026 (Vorregistrierung und Befund im
 * Werkstatt-Repo, VORREGISTRIERUNG-zweitembedding.md):
 *
 *   Einstellsatz (2997 Fragen)   @3  1985 -> 2064  (+79)
 *   Pruefsatz    (3003 Fragen)   @3  1977 -> 2051  (+74)
 *   Eingefrorener Korpus         @3    53 -> 65 %   Platz 1  37 -> 47 %
 *   (100 menschgeschriebene Fragen; alle Untergrenzen gehalten)
 *
 * ADDITIV schlaegt Ersatz (2064 gegen 2021): die beiden Modelle irren an
 * verschiedenen Stellen — zwei Zeugen, nicht ein besserer. Die Gewichtskurve
 * ist flach zwischen 1,0 und 1,5 (2064/2063), der Wert ist also kein
 * Abtast-Glueck. Groessere Modellstufen sind erledigt: qwen3-4b braucht auf
 * unserer CPU 42 s je Text (VORREGISTRIERUNG-zweitembedding-4b.md, Abbruch).
 */
export const ZWEIT_MODELL = 'qwen3-embedding:0.6b';
export const ZWEIT_GEWICHT = 1.0;

/**
 * Ab welcher Deckung des Zweitbestands der Lesepfad das Merkmal nutzt.
 *
 * Die Einbau-Reihenfolge (Karte cgf6kcyrg02s) verlangt: erst Schreibpfad,
 * dann Bestand nachrechnen, DANN Lesepfad. Die Schwelle von 0,8 erzwingt das
 * im Code statt im Gedaechtnis: ein halb gefuellter Zweitbestand wuerde die
 * wenigen Lektionen MIT Vektor systematisch nach vorn spreizen (fehlender
 * Wert wird erst nach dem Spreizen neutral) — das Merkmal saehe schlechter
 * aus, als es ist, und die Instanz sortierte schief, bis jemand es merkt.
 */
export const ZWEIT_MINDESTDECKUNG = 0.8;

/**
 * Ab welcher Vektor-Naehe zwei ANGEZEIGTE Treffer als Beinahe-Duplikat
 * gelten und ihre Daten nebeneinander genannt werden.
 *
 * Fuellt die Luecke NEBEN der Ersetzungs-Mechanik (ersetzt_durch/gilt_bis):
 * zwei fast gleiche Eintraege OHNE expliziten Verweis standen bis zum
 * 01.09.2026 unkommentiert nebeneinander — der Leser musste raten, welcher
 * gilt. Der Hinweis nennt beide Daten und WAEHLT NICHT (die
 * Zeitstempel-Falle: neuer heisst nicht gueltiger — ein anderer
 * Geltungsbereich kann beide wahr machen). 0,9 liegt bewusst hoch: nur
 * wirklich austauschbar klingende Paare, keine thematischen Nachbarn.
 *
 * Gemessen 14.10.2026 am eigenen Brain (888 Volltext-Vektoren): ab 0,9 liegt
 * genau EIN Paar, zwei `ci:*`-Lektionen ohne Text. Echte Doppelungen liegen
 * zwischen 0,80 und 0,87 (DOPPEL_SCHWELLE).
 */
export const NAHDUPLIKAT_SCHWELLE = 0.9;

/**
 * Ab welcher Naehe eine eben geschriebene Lektion als moegliche Doppelung
 * einer aelteren gilt (doppel-kandidat.ts). Nur ein Hinweis: nichts wird
 * zusammengelegt, geloescht oder gewaehlt.
 *
 * Gemessen 14.10.2026, je Lektion der naechste AELTERE Nachbar mit anderem
 * Thema (Volltext-Vektor, bge-m3):
 *
 *   Bestand                 p50    p99    ab 0,80   davon echt
 *   Bench-Korpus (494)      0,66   0,79   4         4 von 4
 *   eigenes Brain (888)     0,66   0,82   18        10 von 15 *
 *
 *   * ohne zwei Paare leerer `ci:*`-Lektionen (DOPPEL_MINDEST_TEXT) und ein
 *     schon verknuepftes Paar; die uebrigen 5 sind Folgeschritte derselben
 *     Messreihe, also ebenfalls einen Blick wert.
 *
 * Darunter kippt es: 0,77–0,80 im Bench 2 von 6 klar gleich, 0,74–0,77 meist
 * nur dasselbe Gebiet. Woerter tragen gar nicht: die hoechste
 * Wort-Ueberlappung zweier Lektionen im eigenen Brain war 0,33.
 * Skripte: .agent/cachly/messungen/dubletten-*.mjs (Orchestrierungs-Repo).
 */
export const DOPPEL_SCHWELLE = 0.8;

/**
 * Wie viele getippte Woerter im Treffer stehen muessen, damit er als Beleg gilt.
 *
 * 1 — ein einziges exakt getroffenes Wort genuegt. Bewusst eine ANZAHL und
 * kein Anteil: ein Anteil bestraft die lange Frage. "xyzzy api key" auf eine
 * Lektion, die das seltene "xyzzy" exakt enthaelt, waere ein Drittel und damit
 * unter jeder brauchbaren Schwelle — obwohl der Treffer genau richtig ist.
 * Genau daran fiel die Probe `brain-flow` am 27.08.2026 rot aus, bevor die
 * Zahl je ausgeliefert wurde.
 *
 * Zwei unscharfe Treffer (Tippfehler-Toleranz, je 0,5) reichen ebenfalls, ein
 * einzelner nicht.
 *
 * Diese Schwelle darf keinen Treffer fressen, der geholfen haette; sie faengt
 * nur die Faelle ab, in denen KEIN getipptes Wort vorkommt und der Treffer
 * allein ueber die Synonym-Bruecke nach oben kam. Genau davor warnt der
 * Kommentar in `search.ts`: die Bruecke landet bei allgemeinen Woertern, und
 * `log` steht in hunderten Lektionen.
 *
 * Sie greift ausserdem nur, wenn KEIN Treffer der Liste belegt ist — nicht als
 * Filter auf einzelne. Entweder die Liste taugt, oder sie taugt nicht.
 *
 * Warum Wortbelege und nicht die Punktzahl: `hybridScore` ist min-max normiert
 * und damit relativ. Ein einzelner Treffer bekommt dort IMMER 0, der beste
 * einer Liste IMMER 1 — beides unbrauchbar fuer "taugt das ueberhaupt?".
 * Die ganze Herleitung steht in abstention.ts.
 *
 * Der Anlass: 21 Prozent der automatisch eingeblendeten Lektionen passten am
 * 13.08.2026 nicht zur Aufgabe. Der Wert selbst ist eine erste, vorsichtige
 * Setzung und noch NICHT am Bench abgetastet — wer ihn aendert, faehrt beide
 * Pflicht-Benches (eigener Satz mit Untergrenzen 41/55/71/97 und LoCoMo) und
 * traegt die Zahl hier ein.
 */
export const WORT_BELEG_SCHWELLE = 1;

export const SINN_BELEG_SCHWELLE = 0.35;

/**
 * Ab welcher Zuversicht eine Ursache-Wirkung-Kante allein als Beleg zaehlt.
 *
 * 0,35 — und das ist bewusst KEINE neue Zahl, sondern dieselbe, die der
 * Graphdurchlauf in `handlers/brain.ts` schon anwendet:
 *
 *     if (!edge || edge.edgeType !== 'fixes' || edge.confidence < 0.35) continue;
 *
 * Eine Zurueckhaltung, die strenger waere als der Filter davor, wuerde
 * Treffer verwerfen, die der Abruf gerade erst bewusst durchgelassen hat.
 * Ein reiner Graph-Treffer haengt ausserdem an einem getippten Wort: der
 * Durchlauf startet nur an Knoten, deren Name ein Fragewort enthaelt.
 */
export const CKG_BELEG_SCHWELLE = 0.35;

/**
 * Ab welchem Punktabstand zwischen Platz 1 und Platz 2 die Suche ihrem
 * eigenen Ergebnis traut. Unter 0,05 gilt der Sieg als Ratespiel: die
 * Treffer werden weiter gezeigt, aber mit dem Satz davor, dass der Bestand
 * nichts klar Bestes hat (`knapperSiegSatz` in rangfolge.ts).
 *
 * Gemessen, nicht gesetzt: auf Haelfte A der Fremd-Fragen eingestellt
 * (bei 0,05: 6,3 falsche je richtiger abgelehnter Antwort), auf Haelfte B
 * genau EINMAL bestaetigt (8,9:1, Praezision unter den Beantworteten
 * +6,7 Punkte bei 76,7 % Deckung). Werkzeug und Regel:
 * `src/bench/dritter-ausgang-messen.ts` — Aenderung nur mit neuem A-Lauf
 * und einmaliger B-Bestaetigung.
 */
export const ABLEHN_ABSTAND = 0.05;

/**
 * Die Laengenkorrektur der Seltenheitsdeckung (BM25-b, Robertson).
 *
 * Bewiesener Mechanismus (verlust-zerlegen.ts, 30.08.2026): bei den
 * Seltenheits-Verlusten war der falsche Sieger im Median 663 Zeichen lang,
 * die richtige Antwort 306 — lange Texte decken seltene Fragewoerter
 * zufaellig ab, und das hoechste Gewicht (1,3) belohnte das.
 *
 * Wert 1,0: auf Haelfte A aus {0,25, 0,5, 0,75, 1,0} gewaehlt
 * (P@1 +0,7, Findequote@3 +0,6) und auf Haelfte B genau EINMAL bestaetigt
 * (P@1 32,1 -> 33,1, @3 41,9 -> 42,7). Ehrlich dazu: die vorregistrierte
 * Erwartung 4 (Seltenheits-Verluste −20 %) wurde VERFEHLT (−10 %) — die
 * Korrektur nimmt der Verzerrung die Spitze, loest die Klasse nicht auf.
 *
 * 0 schaltet die Korrektur ab (alte Formel). Aenderung nur mit neuem
 * A-Lauf und einmaliger B-Bestaetigung (laengenkorrektur-messen.ts).
 */
export const SELTENHEIT_LAENGE_B = 1.0;

/**
 * Der Leser (Cross-Encoder) als achtes Signal — liest Frage und Lektion
 * GEMEINSAM, statt zwei Vektoren zu vergleichen. Laeuft als Dienst hinter
 * POST /api/v1/rerank (api/internal/handler/rerank_handler.go).
 *
 * Gemessen (GPU-Naechte 07./08.09. und 16.09.2026, Befund
 * .agent/BEFUND-gpu-nacht-2026-09-08.md; Pruefsatz 3003 · eingaenge-b ·
 * 25/75 · mit Zweitmodell): kleiner Leser (MiniLM-L12, am Einstellsatz
 * gelernt) ADDITIV ueber die besten 25 Kandidaten — Platz 1 48,8 -> 54,9 %,
 * Findequote@3 64,9 -> 69,3 % (+132); Gegenprobe mit vertauschten Texten
 * bricht auf 240 ein. Auf 99 nie gesehenen Lektionen +3,9 Punkte Platz 1.
 * Als ERSATZ der Hausordnung verliert er (Nominator-Decke 3a: 64,5 % = Haus) —
 * deshalb wird nur die Reihenfolge der besten LESER_TIEFE neu gemischt:
 * Hauspunkt und Leserpunkt je im Topf gespreizt, 1:1 addiert (Arm L4).
 *
 * Gewicht 1,0 = die gemessene 1:1-Mischung. 0 schaltet den Leser ab;
 * CACHLY_LESER=0 in der Umgebung ebenso. Ohne konfigurierten Dienst (503)
 * oder nach dem Zeitlimit sortiert der Topf wie bisher — der Leser darf nie
 * eine Antwort verzoegern, die ohne ihn da waere.
 */
export const LESER_GEWICHT = 1.0;
/**
 * So viele der besten Kandidaten liest der Leser in `smart_recall`: 25, der
 * Topf der Messung (Arm L4, T25). Aenderung nur mit Messung auf dem
 * Pruefsatz (leser-arme-offline.py auf einer punkte.jsonl); auf CPU kosten 25
 * Paare x 256 Token 1,2 s, 10 Paare x 128 Token 230 ms (node-4, 06.10.2026).
 *
 * Offen: unter Bau-Last auf node-4 antwortet der Leser bei 25 Texten nur in
 * 31,6 % der Aufrufe binnen LESER_ZEITLIMIT_MS (Messung an
 * LESER_TIEFE_EINBLENDUNG). Fuer smart_recall ist die kleinere Tiefe nicht
 * gemessen — dessen Kandidatenliste kommt aus einer anderen Sortierung.
 */
export const LESER_TIEFE = 25;
/**
 * So viele der besten Kandidaten liest der Leser in der EINBLENDUNG (Hook je
 * Prompt): 10. Gemessen 11.10.2026 mit einblendung-messen.ts --tiefen
 * 10,15,25 --stichprobe 600 --saat 7 --leser-zeitlimit 8000 (Pruefsatz 3.003,
 * 499 Lektionen; je Frage alle drei Tiefen abwechselnd, Hausleser auf node-4,
 * 65 min, davon die meiste Zeit 4-6 Bau-Jobs auf node-4):
 *
 *   Tiefe   Platz 1 / @3 mit Frist   jede Antwort   Leser p50/p95   binnen 2,5 s
 *   ohne        33,7 / 44,3             -               -                -
 *   10          40,0 / 51,8         40,3 / 52,2     1,37 / 2,63 s       90,9 %
 *   15          40,3 / 51,7         42,3 / 54,3     1,87 / 3,39 s       76,8 %
 *   25          35,8 / 47,3         43,7 / 55,2     2,88 / 4,51 s       31,6 %
 *
 * "Mit Frist" ist, was der Hook bekommt: kommt der Leser nach 2,5 s, bleibt
 * die lokale Ordnung. Bei 25 haelt er so nur +2,1 Punkte Platz 1, bei 10
 * +6,3; 15 ist bei Platz 1 und @3 gleichauf mit 10, wartet aber 0,4 s
 * laenger je Prompt (Mittel 1,90 statt 1,47 s) und faellt bei 4+ Bau-Jobs auf
 * 67 % rechtzeitig (10: 90 %; beides mit 0,09 s fuer den Verbindungsaufbau,
 * den der Hook je Prompt neu bezahlt). Gegenprobe (Erwartungen permutiert): alle Arme
 * <= 0,7 % Platz 1. Stichprobe: +-2 Punkte je Wert.
 *
 * Zurueck auf 15 oder 25 erst, wenn der Leser unter Last schneller antwortet
 * (CPU-Vorrang auf node-4 oder eigene Maschine) — dann mit demselben Lauf.
 *
 * NACHTRAG 11.10.2026 abends — 15. Der Leser hat jetzt CPUWeight 10000 statt
 * 1000 (Abhakliste 2.6: unter Last 25 Texte p50 2.471 → 806 ms). Derselbe
 * Lauf (--tiefen 10,15,25 --stichprobe 600 --saat 7 --leser-zeitlimit 8000
 * --kontrolle, echte CI-Last auf node-4), mit Frist 2,5 s:
 *   10: Platz 1 40,2 %, @3 52,2 %, @10 58,0 % · Leser p50 643 / p95 932 ms · rechtzeitig 100 %
 *   15: Platz 1 42,2 %, @3 54,3 %, @10 62,5 % · Leser p50 920 / p95 1302 ms · rechtzeitig 99,5 %
 *   25: Platz 1 44,0 %, @3 55,7 %, @10 64,0 % · Leser p50 1442 / p95 1956 ms · rechtzeitig 98,6 %
 * Gegenprobe: alle Arme <= 0,7 % Platz 1. 10 → 15 bringt +2,0 Punkte fuer
 * +0,28 s, 15 → 25 nur +1,8 fuer +0,52 s; die Messlatte (Stufe 2) liegt bei
 * 1,5 s je Prompt. Darum 15, nicht 25.
 */
export const LESER_TIEFE_EINBLENDUNG = 15;
/** Zeitlimit des Anrufs beim Dienst: 2500 ms, dann bleibt die Hausordnung. */
export const LESER_ZEITLIMIT_MS = 2500;
/**
 * Zuschnitt des Lesertexts: 1500 Zeichen — der Zuschnitt des Trainings
 * (bench/leser/leser-trainieren.py MAX_ZEICHEN); Text = Thema + Zeilenumbruch
 * + what_worked, genau wie dort. Ein anders zugeschnittener Text ist ein
 * anderes Modell.
 */
export const LESER_MAX_ZEICHEN = 1500;




/**
 * ══ Die Gewichte der automatischen Einblendung (ohne Vektoren) ═════════════
 *
 * Die Einblendung (`tools/ambient-recall/`) feuert bei jedem Prompt und darf
 * deshalb nicht einbetten. Ihr fehlen also drei der fuenf Merkmale, mit denen
 * `GEWICHTE` in rangfolge.ts eingestellt wurde. Eine Stellschraube gilt fuer
 * die Umgebung, in der sie gemessen wurde — diese hier ist die Umgebung ohne
 * Vektoren, und sie braucht eigene Zahlen.
 *
 * ── Wie viel die Vektoren wirklich tragen (06.09.2026) ─────────────────────
 *
 * Erst musste eine falsche Zahl weg. Die Uebergabe vom 06.09. schrieb, der
 * Wortpfad allein trage 45 % Platz 1 — gemessen mit `--sinnpool 0`. Der
 * Schalter nimmt den Vektoren aber nur die NOMINIERUNG, nicht die SORTIERUNG.
 * Derselbe Messstand, dieselben 3003 Fragen, dieselbe Vorauswahl:
 *
 *   --sinnpool 0 (Vektoren sortieren mit)      Platz 1 45 %   @3 60 %
 *   Vektorgewichte auf 0 (wirklich nur Worte)  Platz 1 28 %   @3 43 %
 *
 * Die Vektoren tragen 17 Punkte, nicht null.
 *
 * ── Was ohne sie am besten traegt ──────────────────────────────────────────
 *
 * Ohne Vektoren ist `bewerteTopf` SCHLECHTER als die blosse Wortsuche: seine
 * beiden verbleibenden Merkmale wurden als ERGAENZUNG zu den Vektoren
 * gewichtet, nicht als Sortierung fuer sich. Gemessen auf 800 Fragen des
 * eingefrorenen Pruefsatzes, Topf 75, Platz 1 / @3:
 *
 *   bewerteTopf mit GEWICHTE, ohne Vektoren      25,8 %  44,3 %
 *   nur die Wortsuche (BM25)                     32,8 %  48,8 %
 *   BM25 + 0,5 Deckung + 0,5 Zeuge               36,5 %  49,3 %   <- hier
 *
 * Gewaehlt auf Haelfte A (0,5/0,5 ist dort das Beste aus neun Verdrahtungen),
 * auf Haelfte B genau EINMAL bestaetigt: Platz 1 32,8 -> 36,8 %,
 * @3 49,8 -> 53,3 %. Der Gewinn haelt auf Fragen, die die Wahl nie gesehen hat.
 *
 * Werkzeug: `src/bench/einblendung-messen.ts`. Aenderung nur mit neuem
 * A-Lauf und einmaliger B-Bestaetigung.
 */
export const EINBLENDUNG_DECKUNG = 0.5;
/**
 * Der beste Zeuge in der Einblendung, Wert 0,5.
 *
 * Dieselbe Messung wie EINBLENDUNG_DECKUNG (auf Haelfte A gewaehlt, auf B
 * einmal bestaetigt), dieselbe Aenderungsregel: neuer A-Lauf, eine
 * B-Bestaetigung, Werkzeug `src/bench/einblendung-messen.ts`.
 */
export const EINBLENDUNG_ZEUGE = 0.5;
