/**
 * EINGEFRORENE Kopie der Wortsuche vom Stand vor der Beschleunigung
 * (19.11.2026, origin/main). Sie ist der Massstab fuer
 * wortsuche-gleichheit.test.ts: die schnelle Fassung muss dieselbe Rangliste
 * mit denselben Punkten liefern. NICHT aendern und NICHT "verbessern" — wer die
 * Rangfolge absichtlich aendert, ersetzt diese Datei bewusst und misst vorher
 * den Bench (npm run bench:gate).
 *
 * Unterschiede zum Original: nur der Protokollschritt am Ende (Fehlschlag
 * protokollieren, Wortvorrat fuer "Meintest du") fehlt; Konstanten stehen hier.
 */
import {
  tokenize, splitMultiQuery, levenshtein, recencyBoost,
  type Wortbestand, type KeywordMatch,
} from '../../search.js';

type DocEntry = Wortbestand['docs'][number];
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const BM25_DELTA = 0.25;
const SYNONYM_GEWICHT = 0.5;
const FUZZY_KANDIDATEN = 64;

export function keywordSearchMitBestandAlt(
  bestand: Wortbestand,
  query: string,
  topK: number,
): KeywordMatch[] {
  const { docs, avgDL, docFreq } = bestand;
  const N = docs.length;

  // Bezugszeitpunkt fuer das Alter. Im Produkt ist es die Uhr. Im Messmodus
  // (CACHLY_RECALL_NUR_LESEN=1) ist es der juengste Zeitstempel im Bestand:
  // die Uhr laeuft zwischen zwei Abrufen weiter, der Faktor aendert sich, und
  // fast gleiche Punktzahlen rutschen durch das Runden zusammen oder
  // auseinander. Ein Datenstand gibt jedes Mal denselben Bezug.
  const bezug = process.env.CACHLY_RECALL_NUR_LESEN === '1'
    ? docs.reduce((m, d) => (d.timestamp && d.timestamp > m ? d.timestamp : m), 0)
    : Date.now();

  function idf(term: string): number {
    const df = docFreq.get(term) ?? 0;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * BM25+ score for a term in a document.
   * Classic BM25: TF_norm = tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl))
   * BM25+ adds: + δ  (guarantees long docs with the term still score positively)
   */
  function bm25PlusTerm(term: string, doc: DocEntry): number {
    const tf = doc.tokenFreq.get(term) ?? 0;
    if (tf === 0) return 0;
    const dl = doc.tokens.length;
    const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDL)));
    return idf(term) * (tfNorm + BM25_DELTA);
  }

  // Die frueher hier stehende Funktion `fuzzyMatch(qt, docTermSet)` ist am
  // 19.08.2026 entfallen. Sie lief je Frage UND je Dokument und durchsuchte den
  // Wortvorrat des Dokuments bis zu viermal — bei 499 Lektionen rund 540 der
  // 788 Millisekunden je Frage.
  //
  // An ihre Stelle tritt `fuzzyKandidaten(qt)` weiter unten: die passenden
  // Woerter werden EINMAL je Frage gegen den Gesamtwortschatz bestimmt, danach
  // ist die Pruefung je Dokument ein Nachschlagen.

  // ── Step 3: Score each sub-query independently ──
  const subQueries = splitMultiQuery(query);
  const allMatches = new Map<string, KeywordMatch>();

  for (const sq of subQueries) {
    const queryTokens = tokenize(sq);
    if (queryTokens.length === 0) continue;

    // ── Unscharfe Treffer einmal aufloesen, nicht je Dokument ──────────────
    //
    // Vorher stand im Bewertungsteil `fuzzyMatch(qt, new Set(doc.tokens))` —
    // pro Frage UND pro Dokument. Bei 499 Lektionen mit je rund 300 Woertern
    // und 40 Fragewoertern waren das ueber zwanzig Millionen Zeichenvergleiche,
    // viele davon Levenshtein.
    //
    // Gemessen am 19.08.2026: von 788 ms je Frage entfielen 249 ms auf den
    // Indexaufbau und rund 540 ms auf genau diese Schleife.
    //
    // Der Wortschatz ist fuer alle Dokumente derselbe. Also wird je Fragewort
    // EINMAL bestimmt, welche vorhandenen Woerter dazu passen — danach ist die
    // Pruefung je Dokument ein Nachschlagen in einer Map.
    //
    // Nebeneffekt: das Ergebnis wird VERLAESSLICHER. Vorher nahm fuzzyMatch das
    // erste passende Wort in der Reihenfolge, in der die Woerter eines
    // Dokuments zufaellig standen — dasselbe Fragewort konnte in zwei
    // Dokumenten auf verschiedene Woerter treffen.
    const fuzzySpeicher = new Map<string, Array<[string, number]>>();
    const fuzzyKandidaten = (qt: string): Array<[string, number]> => {
      const da = fuzzySpeicher.get(qt);
      if (da) return da;

      // Alle Kandidaten je Stufe sammeln — NICHT nach den ersten acht
      // abbrechen.
      //
      // Die erste Fassung tat genau das und kostete 15 von 100 Fragen: sie
      // nahm die ersten acht Woerter in der Reihenfolge, in der sie zufaellig
      // im Wortschatz standen, und die passten meist nicht zu dem Dokument,
      // um das es ging. Schneller und schlechter ist kein Fortschritt.
      const sammle = (passt: (dt: string) => boolean, gewichtung: number): Array<[string, number]> => {
        const aus: Array<[string, number]> = [];
        for (const dt of docFreq.keys()) if (passt(dt)) aus.push([dt, gewichtung]);
        // Seltene Woerter zuerst: sie unterscheiden. Ein Wort, das in 300 von
        // 499 Lektionen steht, sagt nichts darueber, welche gemeint ist.
        aus.sort((a, b) => (docFreq.get(a[0]) ?? 0) - (docFreq.get(b[0]) ?? 0));
        return aus.slice(0, FUZZY_KANDIDATEN);
      };

      let aus: Array<[string, number]> = [];
      if (qt.length >= 4) {
        aus = sammle((dt) => dt.length > qt.length && dt.startsWith(qt), 0.85);
      }
      if (aus.length === 0 && qt.length >= 4) {
        aus = sammle((dt) => dt.length >= 4 && dt.length < qt.length && qt.startsWith(dt), 0.75);
      }
      if (aus.length === 0 && qt.length > 3) {
        aus = sammle((dt) => dt.length > 3 && (dt.includes(qt) || qt.includes(dt)), 0.6);
      }
      if (aus.length === 0 && qt.length >= 4) {
        aus = sammle((dt) => dt.length >= 4 && levenshtein(qt, dt) <= 2, 0.4);
      }
      fuzzySpeicher.set(qt, aus);
      return aus;
    };

    // Die Woerter, die der Mensch WIRKLICH getippt hat — ohne Synonyme.
    //
    // Gebraucht wird das fuer den Titel-Bonus weiter unten. Der teilte bisher
    // durch die ERWEITERTE Fragelaenge, und das ist ein Fehler mit Ansage:
    // eine deutsche Frage wird auf ein Vielfaches aufgeblasen (Englisch,
    // Japanisch, Chinesisch, Koreanisch, Arabisch, Russisch ...), also sank
    // der Bonus mit jedem Synonym, das wir der Tabelle hinzufuegten.
    //
    // Gemessen am 19.08.2026: "Jeder Build laedt alle Abhaengigkeiten neu ..."
    // ergab 26 Tokens fuer 12 getippte Woerter. Ein Titeltreffer zaehlte damit
    // 3/26 statt 3/12 — der Bonus fiel von 1,13 auf 1,06.
    //
    // Das ist die unangenehme Sorte Fehler: die Suche zu verbessern (mehr
    // Synonyme) machte den Titel-Bonus schwaecher. Zwei Stellschrauben, die
    // gegeneinander arbeiteten, ohne dass es jemandem auffiel.
    const kernTokens = new Set(tokenize(sq, { crossLingualExpand: false }));

    // Pre-compute query bigrams for proximity boost
    const queryBigrams = new Set<string>();
    for (let j = 0; j < queryTokens.length - 1; j++) {
      queryBigrams.add(`${queryTokens[j]}|${queryTokens[j + 1]}`);
    }

    for (const doc of docs) {
      let score = 0;
      const matchedWords: string[] = [];

      for (const qt of queryTokens) {
        // Ein Wort, das der Mensch getippt hat, zaehlt voll. Ein Synonym, das
        // WIR ergaenzt haben, zaehlt weniger.
        //
        // Grund: die Bruecke von einer Sprache in die andere landet meistens
        // bei allgemeinen Woertern. `Zugriffsprotokoll` wird ueber `protokoll`
        // zu `log`, und `log` steht in hunderten Lektionen. Zaehlt das genauso
        // viel wie ein getipptes seltenes Wort, gewinnt die Breite gegen die
        // Genauigkeit.
        const gewicht = kernTokens.has(qt) ? 1 : SYNONYM_GEWICHT;

        const exactScore = bm25PlusTerm(qt, doc);
        if (exactScore > 0) {
          score += exactScore * gewicht;
          matchedWords.push(qt);
          continue;
        }
        // Unscharfer Treffer — die Kandidaten stehen schon fest, siehe unten.
        for (const [term, gewichtung] of fuzzyKandidaten(qt)) {
          if (!doc.tokenFreq.has(term)) continue;
          score += bm25PlusTerm(term, doc) * gewichtung * gewicht;
          matchedWords.push(`~${qt}`);
          break;
        }
      }

      // Bigram proximity boost: +50% for each adjacent query term pair found in doc
      if (queryBigrams.size > 0) {
        let bigramHits = 0;
        for (const bg of queryBigrams) {
          if (doc.bigrams.has(bg)) bigramHits++;
        }
        if (bigramHits > 0) {
          score *= 1 + 0.5 * (bigramHits / queryBigrams.size);
        }
      }

      // Phrase-match boost: if the raw (lowercased) query appears verbatim in content, 2× boost
      // This rewards docs where the exact phrase exists (vs scattered tokens).
      if (!process.env.AUS_PHRASE && sq.length >= 4 && doc.content.toLowerCase().includes(sq.toLowerCase())) {
        score *= 2.0;
      }

      // Key/title boost: if query terms appear in the Redis key (=title), 1.5× boost
      // Keys often encode the primary topic (e.g. "deploy:api:server"), so key hits are high-precision.
      // Der Titel (Redis-Schluessel) ist das dichteste Feld, das wir haben:
      // `ci:node3-disk-full-zombie-deploy` traegt die Antwort im Namen. Ein
      // Treffer dort ist mehr wert als drei im Fliesstext.
      //
      // Bezugsgroesse sind deshalb die GETIPPTEN Woerter, nicht die erweiterten
      // — siehe kernTokens oben. Und die Obergrenze ist hoeher (2,0 statt 1,5),
      // weil der bisherige Deckel bei langen Fragen nie erreicht wurde.
      if (score > 0) {
        let keyHits = 0;
        let kernHits = 0;
        for (const qt of queryTokens) {
          if (!doc.keyTokens.has(qt)) continue;
          keyHits++;
          if (kernTokens.has(qt)) kernHits++;
        }
        if (keyHits > 0) {
          const anteil = kernHits / Math.max(1, kernTokens.size);
          score *= 1 + 1.0 * Math.min(1, anteil * 2);
        }
      }

      // Recency boost
      score *= recencyBoost(doc.timestamp, bezug);

      if (score > 0) {
        const existing = allMatches.get(doc.key);
        if (!existing || score > existing.score) {
          // Absoluter Wortbeleg: wie viele der GETIPPTEN Kernwoerter stehen
          // wirklich drin? Ergaenzte Synonyme zaehlen hier bewusst nicht mit —
          // sonst koennte die Bruecke in die andere Sprache einen Beleg
          // erzeugen, den der Mensch in seiner Frage nie hatte. Der Kommentar
          // weiter oben sagt, warum: die Bruecke landet bei allgemeinen
          // Woertern, und `log` steht in hunderten Lektionen.
          //
          // Exakt zaehlt 1, unscharf (`~wort`) zaehlt 0,5. Wer "timout" tippt,
          // meint "timeout" — ihm den Treffer wegen zweier Buchstaben zu
          // verschweigen waere der teurere Fehler; ihn allein aber auch nicht
          // als vollen Beleg zu nehmen ist die vorsichtige Mitte.
          const exakt = new Set<string>();
          const unscharf = new Set<string>();
          for (const w of matchedWords) {
            if (w.startsWith('~')) unscharf.add(w.slice(1));
            else exakt.add(w);
          }
          let wortBelege = 0;
          for (const kt of kernTokens) {
            if (exakt.has(kt)) wortBelege += 1;
            else if (unscharf.has(kt)) wortBelege += 0.5;
          }

          allMatches.set(doc.key, {
            key: doc.key,
            content: doc.content,
            score,
            matchedWords: [...new Set(matchedWords)],
            subQuery: subQueries.length > 1 ? sq : undefined,
            wortBelege,
          });
        }
      }
    }
  }

  // ── Step 4: Sort by score, return top-K ──
  // Bei gleicher Punktzahl entscheidet der Schluessel, nicht die Lesereihenfolge
  // des Speichers (gleiche Frage, gleicher Bestand, andere
  // Treffer, sobald der Wortbestand neu gebaut wurde und SCAN anders lieferte).
  const sorted = [...allMatches.values()].sort((a, b) => (b.score - a.score) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const topResults = sorted.slice(0, topK);

  return topResults;
}
