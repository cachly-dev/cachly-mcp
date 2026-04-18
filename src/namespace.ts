/**
 * Namespace Auto-Detection
 *
 * Classify a prompt into one of 5 semantic namespaces using text heuristics.
 * Overhead: <0.1 ms. No embedding required.
 *
 * Covers: EN · DE · FR · ES · IT · PT · NL
 * Source of truth for keyword lists: sdk/shared/filler-words.ts
 */

const CODE_KW = [
  'function ', 'def ', 'class ', 'import ', 'const ', 'let ', 'var ',
  'return ', ' => ', 'void ', 'public class', 'func ', '#include', 'package ',
  'struct ', 'interface ', 'async def', 'lambda ', '#!/',
];

// Translation – EN · DE · FR · ES · IT · PT · NL
const TRANSL_KW = [
  // EN
  'translate', 'in english', 'in german', 'in french', 'in spanish', 'in italian', 'in portuguese',
  // DE
  'übersetze', 'übersetz', 'auf deutsch', 'auf englisch', 'ins deutsche', 'ins englische',
  // FR
  'traduis', 'traduire', 'en français', 'en anglais', 'en allemand', 'en espagnol',
  // ES
  'traduce', 'traducir', 'al español', 'al inglés', 'al alemán',
  // IT
  'traduci', 'in italiano', 'in inglese', 'in tedesco',
  // PT
  'traduz', 'traduzir', 'em português', 'em inglês', 'em alemão',
  // NL
  'vertaal',
];

// Summary – EN · DE · FR · ES · IT · PT
const SUMMARY_KW = [
  // EN
  'summarize', 'summarise', 'summary', 'tl;dr', 'tldr',
  'key points', 'give me a brief', 'in a nutshell', 'in short', 'overview of',
  // DE
  'zusammenfass', 'stichpunkte', 'fasse zusammen', 'kurze zusammenfassung', 'überblick',
  // FR
  'résume', 'résumé', 'résumer', 'points clés', 'en bref', "vue d'ensemble",
  // ES
  'resumir', 'en resumen', 'puntos clave', 'en breve', 'resumen de',
  // IT
  'riassumi', 'riassunto', 'punti chiave', 'in breve', 'panoramica',
  // PT
  'resumir', 'em resumo', 'pontos principais', 'resumo de',
];

// Q&A prefixes – EN · DE · FR · ES · IT · PT
const QA_PREFIXES = [
  // EN
  'what ', 'who ', 'where ', 'when ', 'why ', 'how ', 'which ',
  'is ', 'are ', 'was ', 'were ', 'does ', 'do ', 'did ',
  'can ', 'could ', 'would ', 'should ', 'will ',
  // DE
  'wer ', 'wie ', 'wo ', 'wann ', 'warum ', 'welche', 'wieso ', 'was ist',
  // FR
  "qu'est-ce que", 'comment ', 'pourquoi ', 'quel ', 'quelle ', 'quels ',
  'est-ce que', 'qui est', 'où est', 'quand ',
  // ES
  'qué ', 'cómo ', 'quién ', 'dónde ', 'cuándo ', 'por qué ',
  // IT
  'come ', 'perché ', "cos'è", "com'è", 'dove ', 'quando ', 'chi è',
  // PT
  'o que ', 'como ', 'quem ', 'onde ', 'quando ', 'por que ',
];

/**
 * Classify a prompt into one of 5 semantic namespaces.
 * Returns one of: `cachly:sem:code` | `:translation` | `:summary` | `:qa` | `:creative`
 */
export function detectNamespace(prompt: string): string {
  const s = prompt.trim().toLowerCase();
  if (CODE_KW.some((kw) => s.includes(kw))) return 'cachly:sem:code';
  if (TRANSL_KW.some((kw) => s.includes(kw))) return 'cachly:sem:translation';
  if (SUMMARY_KW.some((kw) => s.includes(kw))) return 'cachly:sem:summary';
  if (QA_PREFIXES.some((p) => s.startsWith(p))) return 'cachly:sem:qa';
  if (s.trimEnd().endsWith('?')) return 'cachly:sem:qa';
  return 'cachly:sem:creative';
}

/**
 * Filler words used by prompt normalisation in MCP context.
 * Source of truth: sdk/shared/filler-words.ts
 * Covers: EN · DE · FR · ES · IT · PT
 */
export const FILLER_WORDS: string[] = [
  // EN
  'please', 'hey', 'hi', 'hello',
  'could you', 'can you', 'would you', 'will you',
  'just', 'quickly', 'briefly', 'simply',
  'tell me', 'show me', 'give me', 'help me', 'assist me',
  'explain to me', 'describe to me',
  'i need', 'i want', 'i would like', "i'd like", "i'm looking for",
  // DE
  'bitte', 'mal eben', 'schnell', 'kurz', 'einfach',
  'kannst du', 'könntest du', 'könnten sie', 'würden sie', 'würdest du',
  'hallo', 'hi', 'hey',
  'sag mir', 'zeig mir', 'gib mir', 'hilf mir', 'erkläre mir', 'erklär mir',
  'ich brauche', 'ich möchte', 'ich hätte gerne', 'ich suche',
  // FR
  "s'il vous plaît", 'svp', 'stp', 'bonjour', 'salut', 'allô',
  'pouvez-vous', 'pourriez-vous', 'peux-tu', 'pourrais-tu',
  'dis-moi', 'dites-moi', 'montre-moi', 'montrez-moi',
  "j'ai besoin de", 'je voudrais', 'je cherche', 'je souhaite',
  'expliquez-moi', 'explique-moi', 'aidez-moi', 'aide-moi',
  // ES
  'por favor', 'hola', 'oye',
  'puedes', 'podrías', 'podría usted', 'me puedes', 'me podrías',
  'dime', 'dígame', 'muéstrame', 'muéstreme', 'dame', 'deme',
  'necesito', 'quisiera', 'me gustaría', 'quiero saber',
  'ayúdame', 'ayúdeme', 'explícame', 'explíqueme',
  // IT
  'per favore', 'perfavore', 'ciao', 'salve', 'ehi',
  'potresti', 'mi potresti', 'potrebbe', 'mi potrebbe',
  'dimmi', 'mi dica', 'mostrami', 'dammi', 'mi dia',
  'ho bisogno di', 'vorrei', 'mi piacerebbe',
  'aiutami', 'mi aiuti', 'spiegami', 'mi spieghi',
  // PT
  'por favor', 'olá', 'oi', 'ei',
  'pode', 'poderia', 'você poderia', 'você pode', 'podes',
  'me diga', 'diga-me', 'me mostre', 'mostre-me', 'me dê', 'dê-me',
  'preciso de', 'gostaria de', 'quero saber', 'estou procurando',
  'me ajude', 'ajude-me', 'explique-me', 'me explique',
];
