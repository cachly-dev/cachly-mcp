import { Redis } from 'ioredis';

// ── Search Engine (BM25+ with enhancements, works without embedding) ──────────
//
// Features beyond standard BM25:
//   • BM25+ (delta=1) — fixes BM25's "long document penalty" bug
//   • Bigram proximity boost — adjacent query terms in doc score 2× more
//   • Recency boost — newer entries rank higher (exponential decay, 7-day half-life)
//   • Multi-query splitting — numbered lists, semicolons, conjunctions
//   • Fuzzy matching with Levenshtein distance ≤ 2
//   • Multilingual stopwords (EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE)
//   • CJK character bigram extraction — handles Chinese, Japanese, Korean
//   • RTL language support (Arabic, Hebrew) — word tokenization + light stemming
//   • Romanization matching — katakana → romaji tokens for romaji queries
//   • Cross-language retrieval — tech term synonyms EN↔JA↔ZH↔KO↔AR↔HE
//   • Pipeline Redis reads for performance
//

/**
 * Stopwords — filtered out during tokenization.
 * Covers: English, German, French, Spanish, Italian, Portuguese,
 *         Chinese (Simplified + Traditional), Japanese, Korean.
 * Keeps the index small and scores meaningful.
 */
const STOPWORDS = new Set([
  // ── English ──
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'about', 'against', 'among', 'around', 'without', 'within',
  'along', 'across', 'behind', 'beyond', 'upon', 'toward', 'towards',
  'and', 'but', 'or', 'not', 'no', 'nor', 'so', 'if', 'then', 'than',
  'too', 'very', 'quite', 'rather', 'just', 'also', 'only', 'even',
  'it', 'its', 'this', 'that', 'these', 'those', 'here', 'there',
  'my', 'your', 'his', 'her', 'our', 'their', 'mine', 'yours', 'ours',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'much', 'many',
  'other', 'some', 'such', 'own', 'same', 'any', 'either', 'neither',
  'been', 'being', 'because', 'until', 'while', 'once', 'again', 'further',
  'already', 'always', 'never', 'sometimes', 'often', 'still', 'yet',
  // ── German ──
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
  'einem', 'einer', 'eines', 'und', 'oder', 'aber', 'denn', 'weil',
  'ist', 'sind', 'war', 'waren', 'sein', 'wird', 'werden', 'wurde',
  'hat', 'haben', 'hatte', 'hatten', 'kann', 'können', 'konnte',
  'soll', 'sollen', 'sollte', 'muss', 'müssen', 'musste', 'darf',
  'mag', 'möchte', 'wollen', 'wollte', 'würde', 'könnte', 'sollte',
  'mit', 'für', 'auf', 'von', 'aus', 'bei', 'nach', 'über', 'unter',
  'vor', 'hinter', 'neben', 'zwischen', 'durch', 'gegen', 'ohne',
  'um', 'bis', 'seit', 'während', 'wegen', 'trotz', 'statt',
  'wie', 'was', 'wer', 'wen', 'wem', 'wessen', 'wo', 'wann', 'warum',
  'nicht', 'noch', 'auch', 'schon', 'nur', 'sehr', 'mehr', 'viel',
  'alle', 'jeder', 'jede', 'jedes', 'dieser', 'diese', 'dieses',
  'jener', 'jene', 'jenes', 'mein', 'dein', 'sein', 'ihr', 'unser',
  'euer', 'kein', 'keine', 'sich', 'mir', 'dir', 'ihm', 'uns', 'euch',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man',
  'hier', 'dort', 'da', 'dann', 'also', 'doch', 'mal', 'eben', 'ganz',
  // ── French ──
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux',
  'et', 'ou', 'mais', 'donc', 'car', 'ni', 'que', 'qui', 'quoi',
  'est', 'sont', 'était', 'ont', 'avoir', 'être', 'fait', 'faire',
  'pour', 'par', 'avec', 'dans', 'sur', 'sous', 'entre', 'vers',
  'chez', 'sans', 'avant', 'après', 'pendant', 'depuis', 'contre',
  'ce', 'cette', 'ces', 'mon', 'ton', 'son', 'notre', 'votre', 'leur',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'on',
  'ne', 'pas', 'plus', 'très', 'bien', 'aussi', 'tout', 'tous', 'toute',
  'même', 'autre', 'quel', 'quelle', 'comment', 'quand', 'où', 'pourquoi',
  // ── Spanish ──
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al',
  'lo', 'que', 'en', 'es', 'por', 'con', 'para', 'como', 'pero', 'más',
  'fue', 'ser', 'hay', 'está', 'han', 'son', 'tiene', 'había', 'era',
  'su', 'sus', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos',
  'mi', 'tu', 'yo', 'él', 'ella', 'nosotros', 'ellos', 'ellas', 'usted',
  'no', 'ya', 'sí', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'donde',
  'muy', 'todo', 'toda', 'todos', 'cada', 'otro', 'otra', 'otros',
  'cuando', 'porque', 'aunque', 'también', 'solo', 'después', 'antes',
  // ── Italian ──
  'il', 'lo', 'la', 'li', 'le', 'gli', 'uno', 'una', 'dei', 'del',
  'che', 'di', 'da', 'per', 'con', 'tra', 'fra', 'sul', 'nel', 'al',
  'è', 'sono', 'ha', 'hanno', 'era', 'essere', 'fare', 'fatto', 'stato',
  'suo', 'sua', 'suoi', 'questo', 'questa', 'questi', 'quello', 'quella',
  'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'ci', 'si',
  'non', 'più', 'molto', 'anche', 'solo', 'tutto', 'tutti', 'ogni',
  'come', 'dove', 'quando', 'perché', 'ancora', 'già', 'sempre', 'mai',
  // ── Portuguese ──
  'um', 'uma', 'uns', 'umas', 'do', 'da', 'dos', 'das', 'no', 'na',
  'ao', 'aos', 'em', 'por', 'com', 'para', 'sem', 'sob', 'sobre',
  'que', 'se', 'mas', 'ou', 'como', 'mais', 'entre', 'até', 'desde',
  'é', 'são', 'foi', 'tem', 'ser', 'ter', 'estar', 'fazer', 'havia',
  'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'esse', 'essa', 'aquele',
  'eu', 'tu', 'ele', 'ela', 'nós', 'eles', 'elas', 'você', 'vocês',
  'não', 'já', 'sim', 'bem', 'muito', 'também', 'ainda', 'sempre',
  'todo', 'toda', 'todos', 'cada', 'outro', 'outra', 'quando', 'porque',
  // ── Chinese (Simplified + Traditional) — high-frequency function characters ──
  '的', '了', '是', '在', '不', '和', '我', '他', '这', '中', '大', '为',
  '上', '个', '国', '以', '要', '就', '出', '说', '们', '有', '来', '到',
  '时', '地', '年', '得', '着', '那', '过', '后', '还', '与', '也', '可',
  '于', '从', '但', '而', '被', '把', '让', '使', '对', '很', '都', '一',
  '会', '没', '人', '它', '这个', '那个', '什么', '如果', '因为', '所以',
  '已经', '可以', '这些', '那些', '我们', '他们', '她们', '它们',
  // ── Japanese — common hiragana particles and auxiliary verbs ──
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'や', 'か', 'な', 'ね',
  'よ', 'わ', 'て', 'い', 'う', 'え', 'お', 'き', 'く', 'け', 'こ', 'さ',
  'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'ぬ', 'ん', 'から', 'まで',
  'より', 'へ', 'です', 'ます', 'ない', 'ある', 'いる', 'する', 'こと',
  'もの', 'ので', 'では', 'には', 'との', 'への', 'から', 'まで',
  // ── Korean — common particles and auxiliary forms ──
  '이', '가', '은', '는', '을', '를', '의', '에', '와', '과', '도',
  '로', '에서', '한', '하', '있', '없', '것', '수', '않', '들',
  '이다', '하다', '이고', '이며', '라고', '에게', '에서', '으로',
  // ── Arabic — high-frequency function words & particles ──
  'في', 'من', 'إلى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'الذي', 'التي', 'الذين', 'اللواتي', 'هو', 'هي', 'هم', 'هن', 'نحن',
  'أنت', 'أنتم', 'أنا', 'كان', 'كانت', 'كانوا', 'يكون', 'تكون',
  'أن', 'إن', 'لأن', 'لكن', 'أو', 'بل', 'ثم', 'حتى', 'إذا', 'كي',
  'قد', 'لقد', 'لم', 'لن', 'ما', 'لا', 'ليس', 'غير', 'بعض', 'كل',
  'جميع', 'أي', 'كيف', 'متى', 'أين', 'لماذا', 'ماذا', 'هل', 'ال',
  'و', 'ف', 'ب', 'ل', 'ك', 'يا', 'أم', 'إلا', 'عند', 'بين',
  // ── Hebrew — common particles, pronouns, conjunctions ──
  'של', 'את', 'אל', 'על', 'עם', 'לא', 'הוא', 'היא', 'הם', 'הן',
  'אני', 'אתה', 'אנחנו', 'אתם', 'כי', 'אם', 'אבל', 'גם', 'כבר',
  'רק', 'עוד', 'יש', 'אין', 'מה', 'זה', 'זאת', 'אלה', 'כל', 'כן',
  'לו', 'לה', 'להם', 'בו', 'בה', 'בהם', 'שם', 'כך', 'כן', 'מי',
  'אשר', 'אחרי', 'לפני', 'תחת', 'בין', 'מאז', 'עד', 'כמו', 'אז',
  // ── Farsi/Persian — common function words, prepositions, pronouns ──
  'در', 'از', 'به', 'با', 'که', 'این', 'آن', 'را', 'است',
  'بود', 'باشد', 'شد', 'شده', 'می', 'نه', 'نیست', 'هم', 'هر',
  'یک', 'اما', 'و', 'یا', 'تا', 'اگر', 'برای', 'چون', 'چه',
  'کجا', 'کی', 'چطور', 'وقتی', 'بعد', 'قبل', 'مثل', 'همه', 'بعضی',
  'هیچ', 'آیا', 'خود', 'چند', 'دیگر', 'هنوز', 'همان', 'آنها', 'اینها',
  'ما', 'شما', 'آنان', 'من', 'تو', 'او', 'آنان', 'ایشان',
  'روی', 'زیر', 'بین', 'پیش', 'پس', 'طرف', 'داخل', 'خارج', 'کنار',
  'همچنین', 'مگر', 'ولی', 'وگرنه', 'چرا', 'چگونه', 'کدام',
  // ── Hindi — common particles, postpositions, pronouns, auxiliary verbs ──
  'है', 'में', 'से', 'को', 'का', 'की', 'के', 'पर', 'और', 'या',
  'नहीं', 'यह', 'वह', 'एक', 'इस', 'उस', 'भी', 'हो', 'था', 'थी',
  'थे', 'हैं', 'हूँ', 'लिए', 'तक', 'साथ', 'बाद', 'पहले', 'जो',
  'जब', 'कैसे', 'क्यों', 'क्या', 'कहाँ', 'कौन', 'हम', 'आप', 'वे',
  'मैं', 'तुम', 'उन', 'इन', 'ने', 'बहुत', 'सब', 'कुछ', 'फिर',
  'अब', 'तो', 'ही', 'तरह', 'जैसे', 'करना', 'होना', 'रहा', 'रही',
  'रहे', 'गया', 'गई', 'गए', 'किया', 'किए', 'कर', 'हुआ', 'हुई',
  // ── Russian — common prepositions, pronouns, auxiliary verbs ───────────────
  'в', 'на', 'не', 'с', 'и', 'а', 'но', 'по', 'за', 'из', 'от', 'до',
  'к', 'у', 'о', 'об', 'во', 'при', 'под', 'над', 'без', 'для',
  'что', 'как', 'это', 'все', 'так', 'уже', 'или', 'же', 'ли',
  'если', 'то', 'да', 'нет', 'был', 'была', 'были', 'быть', 'есть',
  'его', 'её', 'их', 'этот', 'эта', 'эти', 'который', 'которая',
  'которые', 'который', 'мой', 'моя', 'мои', 'ваш', 'ваша', 'ваши',
  'он', 'она', 'они', 'мы', 'вы', 'я', 'ты', 'тот', 'та', 'те',
  'очень', 'тоже', 'также', 'когда', 'где', 'как', 'почему', 'зачем',
  'сейчас', 'здесь', 'там', 'потому', 'поэтому', 'чтобы', 'тут',
  // ── Turkish — common particles, postpositions, copulas ─────────────────────
  'bir', 'bu', 'şu', 'o', 've', 'ile', 'de', 'da', 'için', 'gibi',
  'ama', 'fakat', 'ancak', 'ya', 'ne', 'ki', 'mi', 'mı', 'mu', 'mü',
  'var', 'yok', 'olan', 'oldu', 'olur', 'olarak', 'ise', 'daha',
  'çok', 'en', 'her', 'hiç', 'bazı', 'tüm', 'bütün', 'hem', 'veya',
  'bu', 'şu', 'ben', 'sen', 'biz', 'siz', 'onlar', 'benim', 'senin',
  'nasıl', 'neden', 'niçin', 'nerede', 'ne', 'hangi', 'kaç',
  // ── Polish — common prepositions, pronouns, particles ─────────────────────
  'w', 'na', 'z', 'do', 'się', 'że', 'to', 'jest', 'i', 'a', 'nie',
  'tak', 'jak', 'czy', 'po', 'o', 'ale', 'go', 'mu', 'jej', 'ich',
  'tego', 'tej', 'te', 'ten', 'ta', 'są', 'był', 'była', 'było', 'byli',
  'będzie', 'będą', 'ma', 'mam', 'masz', 'mają', 'ze', 'co', 'już',
  'przez', 'przy', 'za', 'bez', 'nad', 'pod', 'przed', 'po', 'między',
  'kiedy', 'gdzie', 'dlaczego', 'który', 'która', 'które', 'tylko', 'też',
  // ── Czech — common words ──────────────────────────────────────────────────
  'v', 'na', 'z', 'do', 'se', 'že', 'to', 'je', 'a', 'ne', 'pro',
  'ale', 'jak', 'by', 'byl', 'být', 'jsem', 'jsou', 'má', 'mám',
  'ten', 'ta', 'ty', 'tato', 'jeho', 'její', 'jejich', 'také', 'jen',
  'kde', 'kdy', 'proč', 'který', 'která', 'které', 'co', 'při', 'bez',
  // ── Bengali — common particles, pronouns, verbs ───────────────────────────
  'এই', 'এটি', 'এটা', 'এর', 'তার', 'তারা', 'আমি', 'তুমি', 'সে', 'আমরা',
  'এবং', 'কিন্তু', 'বা', 'না', 'হ্যাঁ', 'যে', 'কি', 'কে', 'কী', 'থেকে',
  'দিয়ে', 'জন্য', 'সাথে', 'মধ্যে', 'উপর', 'নিচে', 'আছে', 'ছিল', 'হয়',
  'করা', 'করে', 'করেছে', 'হবে', 'হয়েছে', 'একটি', 'একটা', 'অনেক', 'সব',
  // ── Vietnamese — common particles, pronouns, auxiliary words ─────────────
  'tôi', 'bạn', 'anh', 'chị', 'em', 'họ', 'chúng', 'ta', 'mình',
  'là', 'có', 'không', 'và', 'với', 'của', 'cho', 'trong', 'về',
  'từ', 'đến', 'để', 'khi', 'nếu', 'thì', 'mà', 'nhưng', 'vì',
  'đây', 'đó', 'này', 'kia', 'rất', 'cũng', 'đã', 'sẽ', 'đang',
  'được', 'bị', 'những', 'các', 'một', 'hai', 'ba', 'nhiều', 'ít',
  'nào', 'ai', 'gì', 'đâu', 'sao', 'bao', 'giờ', 'lúc', 'sau',
]);


// CJK Unicode ranges used for bigram extraction
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SEGMENT_RE = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+|[^\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+)/g;

// RTL Unicode ranges: Arabic (U+0600–U+06FF + extended), Hebrew (U+0590–U+05FF)
const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufb4f\ufb50-\ufdff\ufe70-\ufeff]/;
// Distinguish Arabic from Hebrew within RTL segments
const HEBREW_CHAR_RE = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
const _ARABIC_CHAR_RE  = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
// Persian/Farsi: exclusive chars not in Arabic (U+067E=پ, U+0686=چ, U+0698=ژ, U+06AF=گ, U+06CC=ی)
const FARSI_CHAR_RE   = /[\u067e\u0686\u0698\u06af\u06cc]/;
// Devanagari (Hindi, Sanskrit, Marathi …) — U+0900–U+097F + extended
const DEVANAGARI_RE   = /[\u0900-\u097f]/;
// Cyrillic (Russian, Bulgarian, Ukrainian, Serbian …) — U+0400–U+04FF
const CYRILLIC_RE     = /[\u0400-\u04ff]/;
// Turkish uses Latin alphabet but has unique chars (ğ, ş, ı, ö, ü, ç) — detected by these
const TURKISH_CHAR_RE = /[\u011f\u015f\u0131\u0130\u00e7]/; // ğ ş ı İ ç
// Bengali (Bangla) — U+0980–U+09FF
const BENGALI_RE      = /[\u0980-\u09ff]/;
// Vietnamese uses Latin + Latin Extended Additional (U+1EA0–U+1EF9) for tone marks
// e.g. ắ ặ ầ ổ ợ ụ ừ — detected by chars exclusive to Vietnamese diacritics
const _VIETNAMESE_CHAR_RE = /[\u1ea0-\u1ef9]/;

// ── Katakana → Romaji conversion table (Hepburn system) ──────────────────────
// Digraphs must be listed before single chars so they match first.
const KATA_ROMAJI_TABLE: [string, string][] = [
  // Special combinations for loanwords
  ['ファ', 'fa'], ['フィ', 'fi'], ['フェ', 'fe'], ['フォ', 'fo'],
  ['ティ', 'ti'], ['ディ', 'di'], ['トゥ', 'tu'], ['ドゥ', 'du'],
  ['ウィ', 'wi'], ['ウェ', 'we'], ['ウォ', 'wo'],
  ['チェ', 'che'], ['ジェ', 'je'], ['シェ', 'she'],
  ['イェ', 'ye'], ['ヴァ', 'va'], ['ヴィ', 'vi'], ['ヴェ', 've'], ['ヴォ', 'vo'],
  // Digraphs (2-char → romaji)
  ['キャ', 'kya'], ['キュ', 'kyu'], ['キョ', 'kyo'],
  ['シャ', 'sha'], ['シュ', 'shu'], ['ショ', 'sho'],
  ['チャ', 'cha'], ['チュ', 'chu'], ['チョ', 'cho'],
  ['ニャ', 'nya'], ['ニュ', 'nyu'], ['ニョ', 'nyo'],
  ['ヒャ', 'hya'], ['ヒュ', 'hyu'], ['ヒョ', 'hyo'],
  ['ミャ', 'mya'], ['ミュ', 'myu'], ['ミョ', 'myo'],
  ['リャ', 'rya'], ['リュ', 'ryu'], ['リョ', 'ryo'],
  ['ギャ', 'gya'], ['ギュ', 'gyu'], ['ギョ', 'gyo'],
  ['ジャ', 'ja'], ['ジュ', 'ju'], ['ジョ', 'jo'],
  ['ビャ', 'bya'], ['ビュ', 'byu'], ['ビョ', 'byo'],
  ['ピャ', 'pya'], ['ピュ', 'pyu'], ['ピョ', 'pyo'],
  // Single chars
  ['ア', 'a'], ['イ', 'i'], ['ウ', 'u'], ['エ', 'e'], ['オ', 'o'],
  ['カ', 'ka'], ['キ', 'ki'], ['ク', 'ku'], ['ケ', 'ke'], ['コ', 'ko'],
  ['サ', 'sa'], ['シ', 'shi'], ['ス', 'su'], ['セ', 'se'], ['ソ', 'so'],
  ['タ', 'ta'], ['チ', 'chi'], ['ツ', 'tsu'], ['テ', 'te'], ['ト', 'to'],
  ['ナ', 'na'], ['ニ', 'ni'], ['ヌ', 'nu'], ['ネ', 'ne'], ['ノ', 'no'],
  ['ハ', 'ha'], ['ヒ', 'hi'], ['フ', 'fu'], ['ヘ', 'he'], ['ホ', 'ho'],
  ['マ', 'ma'], ['ミ', 'mi'], ['ム', 'mu'], ['メ', 'me'], ['モ', 'mo'],
  ['ヤ', 'ya'], ['ユ', 'yu'], ['ヨ', 'yo'],
  ['ラ', 'ra'], ['リ', 'ri'], ['ル', 'ru'], ['レ', 're'], ['ロ', 'ro'],
  ['ワ', 'wa'], ['ヲ', 'wo'], ['ン', 'n'],
  // Voiced
  ['ガ', 'ga'], ['ギ', 'gi'], ['グ', 'gu'], ['ゲ', 'ge'], ['ゴ', 'go'],
  ['ザ', 'za'], ['ジ', 'ji'], ['ズ', 'zu'], ['ゼ', 'ze'], ['ゾ', 'zo'],
  ['ダ', 'da'], ['ヂ', 'ji'], ['ヅ', 'zu'], ['デ', 'de'], ['ド', 'do'],
  ['バ', 'ba'], ['ビ', 'bi'], ['ブ', 'bu'], ['ベ', 'be'], ['ボ', 'bo'],
  ['パ', 'pa'], ['ピ', 'pi'], ['プ', 'pu'], ['ペ', 'pe'], ['ポ', 'po'],
  ['ヴ', 'v'],
  // Long vowel / small chars
  ['ー', ''], ['ァ', 'a'], ['ィ', 'i'], ['ゥ', 'u'], ['ェ', 'e'], ['ォ', 'o'],
  ['ッ', ''],  // handled separately (doubles next consonant)
];

const KATA_MAP = new Map<string, string>(KATA_ROMAJI_TABLE);

/**
 * Convert a katakana string to Hepburn romaji.
 * Handles digraphs, geminate consonants (ッ), and long vowel marks (ー).
 */
function katakanaToRomaji(kata: string): string {
  let result = '';
  let i = 0;
  while (i < kata.length) {
    // Geminate consonant: ッ doubles the following consonant
    if (kata[i] === 'ッ' && i + 1 < kata.length) {
      const next = KATA_MAP.get(kata[i + 1]) ?? KATA_MAP.get(kata[i + 1] + kata[i + 2]) ?? '';
      if (next.length > 0) result += next[0]; // double first consonant
      i++;
      continue;
    }
    // Try 2-char digraph first
    if (i + 1 < kata.length) {
      const two = kata[i] + kata[i + 1];
      const r2 = KATA_MAP.get(two);
      if (r2 !== undefined) { result += r2; i += 2; continue; }
    }
    // Single char
    const r1 = KATA_MAP.get(kata[i]);
    if (r1 !== undefined) result += r1;
    i++;
  }
  return result;
}

/**
 * Arabic light stemmer — strips definite article and common prefix particles.
 * Handles: ال (al-), و (wa-), ب (bi-), ل (li-), ف (fa-), ك (ka-).
 * Runs iteratively (max 3 passes) so compound prefixes like فال- are fully
 * resolved: فالخطأ → الخطأ → خطأ.
 * Only strips when the result is still ≥ 3 chars to avoid over-stemming.
 */
function arabicLightStem(word: string): string {
  let result = word;
  for (let i = 0; i < 3; i++) {
    const prev = result;
    if (result.startsWith('ال') && result.length > 4) {
      result = result.slice(2);
    } else if (result.length > 3 && 'وبلفك'.includes(result[0]) && RTL_RE.test(result[1])) {
      result = result.slice(1);
    }
    if (result === prev) break; // stable — no more prefixes to strip
  }
  return result;
}

/**
 * Hebrew light stemmer — strips the definite article and common prefix particles
 * that attach directly to words (no space) in Hebrew.
 *
 * Handles:
 *   ה (ha-) — definite article:   הפריסה → פריסה
 *   ו (ve-/u-) — conjunction “and”: ופריסה → פריסה
 *   ב (be-/bi-) — preposition “in”: בסביבה → סביבה
 *   ל (le-/li-) — preposition “for”: לשרת → שרת
 *   מ (mi-/me-) — preposition “from”: מהשרת → השרת → שרת
 *   כ (ke-/ki-) — preposition “like”: כשרת → שרת
 *
 * Iterative (max 3 passes): מהפריסה → הפריסה → פריסה.
 * Only strips when result is still ≥ 3 chars.
 */
function hebrewLightStem(word: string): string {
  let result = word;
  for (let i = 0; i < 3; i++) {
    const prev = result;
    if (result.length > 3 && 'הובלמכ'.includes(result[0]) && HEBREW_CHAR_RE.test(result[1])) {
      result = result.slice(1);
    }
    if (result === prev) break;
  }
  return result;
}

/**
 * Farsi/Persian light stemmer — handles Persian morphology.
 * Strips:
 *   \u0647\u0627 / \u0647\u0627\u06cc (ha/haye) — plural suffixes:  \u0633\u0631\u0648\u0631\u0647\u0627 \u2192 \u0633\u0631\u0648\u0631
 *   \u0645\u06cc\u200c / \u0645\u06cc   (mi-)    — present-tense prefix: \u0645\u06cc\u200c\u06a9\u0646\u062f \u2192 \u06a9\u0646\u062f
 *   \u0646\u0645\u06cc\u200c             (nami-)  — negated present:  \u0646\u0645\u06cc\u200c\u0634\u0648\u062f \u2192 \u0634\u0648\u062f
 * Only strips when the result is still \u2265 3 chars.
 */
function farsiLightStem(word: string): string {
  let result = word;
  // Suffixes first (longest first)
  if (result.endsWith('\u0647\u0627\u06cc') && result.length > 5) result = result.slice(0, -3);
  else if (result.endsWith('\u0647\u0627') && result.length > 4) result = result.slice(0, -2);
  // Prefixes
  if (result.startsWith('\u0646\u0645\u06cc\u200c') && result.length > 5) result = result.slice(4);
  else if (result.startsWith('\u0645\u06cc\u200c') && result.length > 4) result = result.slice(3);
  else if (result.startsWith('\u0645\u06cc') && result.length > 4) result = result.slice(2);
  return result;
}

/**
 * Hindi light stemmer — strips the most common inflectional suffixes.
 * Handles basic verb forms and oblique plural markers.
 * Avoids over-stemming loanwords (most tech terms in Hindi are English loanwords).
 * Only strips when result is still \u2265 3 chars.
 */
function hindiLightStem(word: string): string {
  const result = word;
  // Infinitive / verb suffixes (longest first to avoid partial match)
  if (result.endsWith('\u0928\u093e') && result.length > 4) return result.slice(0, -2); // \u0928\u093e (nā) infinitive
  if (result.endsWith('\u0928\u0947') && result.length > 4) return result.slice(0, -2); // \u0928\u0947 (ne) ergative
  if (result.endsWith('\u0928\u0940') && result.length > 4) return result.slice(0, -2); // \u0928\u0940 (nī) fem infinitive
  if (result.endsWith('\u0924\u093e') && result.length > 4) return result.slice(0, -2); // \u0924\u093e (tā) m present participle
  if (result.endsWith('\u0924\u0940') && result.length > 4) return result.slice(0, -2); // \u0924\u0940 (tī) f present participle
  if (result.endsWith('\u0915\u0930') && result.length > 4) return result.slice(0, -2); // \u0915\u0930 (kar) conjunctive
  if (result.endsWith('\u0913\u0902') && result.length > 4) return result.slice(0, -2); // \u0913\u0902 (oṃ) oblique plural
  if (result.endsWith('\u0907\u092f\u093e\u0902') && result.length > 5) return result.slice(0, -4); // \u0907\u092f\u093e\u0902 (iyāṃ) f plural
  if (result.endsWith('\u0940\u092f\u093e\u0902') && result.length > 5) return result.slice(0, -4); // \u0940\u092f\u093e\u0102 (īyāṃ)
  return result;
}

/**
 * Russian light stemmer — strips common inflectional suffixes.
 * Handles the most frequent verb/noun/adjective endings to improve recall.
 * Only strips when result is still ≥ 3 chars.
 *
 * Covers:
 *  ошибки/ошибка → ошибк  (noun plural/genitive)
 *  развёртывание → развёртыва  (gerund → stem)
 *  установить → установ  (infinitive)
 *  настройки → настройк  (genitive plural)
 */
function russianLightStem(word: string): string {
  const w = word;
  // Longest first to avoid partial stripping
  // Verb infinitives / gerunds
  if (w.endsWith('ывание') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('ивание') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('ование') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('вание')  && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('ение')   && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('ание')   && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('ить')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ать')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('еть')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('уть')    && w.length > 4) return w.slice(0, -3);
  // Noun plural/genitive
  if (w.endsWith('ки')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ги')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ов')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ев')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ей')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ий')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ый')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ая')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ое')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ую')     && w.length > 4) return w.slice(0, -2);
  // Verb present tense
  if (w.endsWith('ет')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ют')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ут')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ят')     && w.length > 4) return w.slice(0, -2);
  return w;
}

/**
 * Turkish light stemmer — strips common agglutinative suffixes.
 * Turkish is highly agglutinative; this covers the most common inflectional ends.
 *
 * Covers:
 *  hatalar → hata  (-lar/-ler plural)
 *  sunucuda → sunucu  (-da/-de locative)
 *  dağıtımı → dağıtım  (-ı/-i/-u/-ü accusative)
 *  yüklemek → yükle  (-mek/-mak infinitive)
 */
function turkishLightStem(word: string): string {
  const w = word;
  // Suffixes longest-first
  if (w.endsWith('lardaki') && w.length > 7) return w.slice(0, -7);
  if (w.endsWith('lerdeki') && w.length > 7) return w.slice(0, -7);
  if (w.endsWith('ların')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('lerin')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('larda')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('lerde')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('ları')    && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('leri')    && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('mek')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('mak')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ler')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('lar')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nın')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nin')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nun')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nün')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('da')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('de')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ta')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('te')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('dan')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('den')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('tan')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ten')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ın')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('in')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('un')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ün')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ı')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('i')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('u')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('ü')       && w.length > 4) return w.slice(0, -1);
  return w;
}

/**
 * Bengali (Bangla) light stemmer — strips common verbal and nominal suffixes.
 * Bengali is an Indo-Aryan language with moderate morphological complexity.
 * Only strips when result is still ≥ 2 chars.
 *
 * Covers:
 *  করছে/করেছে → কর  (progressive/perfect aspect)
 *  সার্ভারগুলো → সার্ভার  (-গুলো plural)
 *  সমস্যাটি → সমস্যা  (-টি singular marker)
 */
function bengaliLightStem(word: string): string {
  const w = word;
  // Plural / collective markers (longest first)
  if (w.endsWith('\u0997\u09c1\u09b2\u09cb') && w.length > 5) return w.slice(0, -4); // গুলো (-gulo plural)
  if (w.endsWith('\u0997\u09c1\u09b2\u09bf') && w.length > 5) return w.slice(0, -4); // গুলি (-guli plural)
  if (w.endsWith('\u09a6\u09c7\u09b0') && w.length > 4) return w.slice(0, -3); // দের (genitive plural)
  if (w.endsWith('\u09a6\u09bf\u0997\u09c7') && w.length > 5) return w.slice(0, -4); // দিগে
  // Definiteness / case markers
  if (w.endsWith('\u099f\u09bf') && w.length > 3) return w.slice(0, -2); // টি (singular definite)
  if (w.endsWith('\u099f\u09be') && w.length > 3) return w.slice(0, -2); // টা (singular definite)
  if (w.endsWith('\u0996\u09be\u09a8\u09be') && w.length > 5) return w.slice(0, -4); // খানা
  // Verbal suffixes
  if (w.endsWith('\u099b\u09c7') && w.length > 3) return w.slice(0, -2); // ছে (progressive)
  if (w.endsWith('\u099b\u09bf\u09b2') && w.length > 4) return w.slice(0, -3); // ছিল (past progressive)
  if (w.endsWith('\u09af\u09be\u09ac\u09c7') && w.length > 5) return w.slice(0, -4); // যাবে (future)
  if (w.endsWith('\u0995\u09b0\u09be') && w.length > 4) return w.slice(0, -3); // করা (infinitive)
  if (w.endsWith('\u0995\u09b0\u09c7') && w.length > 4) return w.slice(0, -3); // করে (present)
  if (w.endsWith('\u09b9\u09df') && w.length > 3) return w.slice(0, -2); // হয় (is/becomes)
  if (w.endsWith('\u09b9\u09ac\u09c7') && w.length > 4) return w.slice(0, -3); // হবে (will be)
  return w;
}

/**
 * Pre-process text BEFORE tokenization to split code identifiers.
 * Handles camelCase, PascalCase, snake_case, and kebab-case.
 *
 * Examples:
 *   deployServer       → deploy Server  (then lowercased → deploy server)
 *   HTMLParser         → HTML Parser
 *   my_api_key         → my api key
 *   get-user-by-id     → get user by id (hyphens preserved in regex, spaces also fine)
 *   BackendServiceImpl → Backend Service Impl
 */
function preprocessText(text: string): string {
  return text
    // camelCase boundary: lowercase/digit → uppercase
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // Consecutive uppercase → uppercase+lowercase boundary: HTMLParser → HTML Parser
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    // snake_case: replace underscores with spaces
    .replace(/_/g, ' ');
}


// Maps tokens (English, Japanese katakana, Chinese, Korean, Arabic, Hebrew)
// to their equivalents in other languages. Used to expand tokens at search time
// so "deploy" finds documents containing "デプロイ" / "部署" / "배포", and vice versa.
//
// Keys must be lowercase. CJK values will be bigram-expanded at use time.
const CROSS_LINGUAL_MAP = new Map<string, string[]>([

  // ── Tech / Ecosystem synonyms (language-agnostic) ─────────────────────────
  ['javascript',    ['js', 'node', 'nodejs', 'ecmascript']],
  ['js',            ['javascript', 'node', 'nodejs']],
  ['typescript',    ['ts', 'javascript', 'js', 'tsc']],
  ['ts',            ['typescript', 'javascript', 'js']],
  ['python',        ['py', 'pip', 'django', 'flask', 'fastapi']],
  ['py',            ['python', 'pip']],
  ['golang',        ['go', 'gopher', 'goroutine']],
  ['go',            ['golang', 'goroutine']],
  ['rust',          ['cargo', 'rustlang', 'crates']],
  ['cargo',         ['rust', 'rustlang']],
  ['java',          ['jvm', 'maven', 'gradle', 'spring']],
  ['kotlin',        ['jvm', 'android', 'coroutine']],
  ['dotnet',        ['csharp', 'asp', 'nuget', 'aspnet']],
  ['postgresql',    ['postgres', 'pg', 'psql']],
  ['postgres',      ['postgresql', 'pg', 'psql']],
  ['mysql',         ['mariadb', 'sql']],
  ['mongodb',       ['mongo', 'nosql', 'bson', 'mongoose']],
  ['mongo',         ['mongodb', 'nosql', 'bson']],
  ['elasticsearch', ['elastic', 'opensearch', 'lucene', 'kibana']],
  ['elastic',       ['elasticsearch', 'opensearch']],
  ['kubernetes',    ['k8s', 'kube', 'kubectl', 'helm', 'k3s']],
  ['k8s',           ['kubernetes', 'kube', 'kubectl', 'helm']],
  ['helm',          ['kubernetes', 'k8s', 'chart']],
  ['terraform',     ['tf', 'hcl', 'iac', 'opentofu']],
  ['ansible',       ['playbook', 'automation']],
  ['grafana',       ['dashboard', 'visualization', 'metrics']],
  ['prometheus',    ['metrics', 'alert', 'scrape', 'grafana']],
  ['nginx',         ['proxy', 'webserver', 'ingress']],
  ['traefik',       ['proxy', 'ingress', 'router']],
  ['rabbitmq',      ['amqp', 'queue', 'broker', 'messaging']],
  ['kafka',         ['messaging', 'stream', 'broker']],
  ['grpc',          ['protobuf', 'proto', 'rpc']],
  ['graphql',       ['gql', 'resolver', 'schema']],
  ['react',         ['jsx', 'hooks', 'component', 'redux']],
  ['nextjs',        ['next', 'react', 'ssr', 'vercel']],
  ['vue',           ['vuejs', 'vite', 'nuxt']],
  ['angular',       ['ng', 'rxjs', 'typescript']],
  ['aws',           ['amazon', 'ec2', 's3', 'lambda', 'cloudwatch', 'ecs', 'eks']],
  ['gcp',           ['google cloud', 'gke', 'bigquery']],
  ['azure',         ['microsoft cloud', 'aks', 'devops']],
  ['s3',            ['bucket', 'object storage', 'aws']],
  ['lambda',        ['serverless', 'function', 'faas', 'aws']],
  ['jwt',           ['token', 'bearer', 'oauth', 'auth']],
  ['oauth',         ['oidc', 'auth', 'token', 'sso']],
  ['webhook',       ['callback', 'event', 'trigger']],
  ['cron',          ['schedule', 'job', 'timer']],
  ['yaml',          ['yml', 'config', 'manifest']],
  ['dotenv',        ['env', 'environment', 'envfile']],
  ['github',        ['git', 'actions', 'repo', 'ci']],
  ['gitlab',        ['git', 'pipeline', 'runner']],
  ['wireguard',     ['vpn', 'tunnel', 'wg']],
  ['prisma',        ['orm', 'database', 'schema', 'migration']],
  ['npm',           ['node', 'package', 'registry', 'yarn', 'pnpm']],
  ['yarn',          ['npm', 'package', 'node']],
  ['pip',           ['python', 'package', 'pypi']],
  ['brew',          ['homebrew', 'macos', 'package']],
  // English → all
  ['deploy',      ['デプロイ', '部署', '배포', 'deployment', 'deploying', 'نشر', 'פריסה', 'استقرار', 'तैनाती', 'bereitstellen', 'bereitstellung', 'déployer', 'déploiement', 'desplegar', 'despliegue', 'distribuire', 'distribuzione', 'implantar', 'implantação', 'развёртывание', 'развертывание', 'dağıtım', 'dağıtmak', 'triển khai']],
  ['deployment',  ['デプロイ', '部署', '배포', 'deploy', 'نشر', 'פריסה', 'استقرار', 'तैनाती', 'bereitstellung', 'déploiement', 'despliegue', 'distribuzione', 'implantação', 'развёртывание', 'dağıtım', 'triển khai']],
  ['container',   ['コンテナ', '容器', '컨테이너', 'docker']],
  ['server',      ['サーバー', 'サーバ', '服务器', '서버', 'سيرفر', 'שרת', 'سرور', 'सर्वर', 'сервер', 'sunucu', 'máy chủ']],
  ['database',    ['データベース', '数据库', '데이터베이스', 'db', 'قاعدة البيانات', 'datenbank', 'پایگاه داده', 'डेटाबेس', 'base de données', 'base de datos', 'banco de dados']],
  ['cache',       ['キャッシュ', '缓存', '캐시', 'كاش', 'מטמון', 'کش', 'कैश', 'кэш', 'önbellek', 'bộ đệm']],
  ['error',       ['エラー', '错误', '오류', 'خطأ', 'שגיאה', 'خطا', 'त्रुटि', 'गलती', 'exception', 'err', 'fehler', 'erreur', 'fallo', 'errore', 'erro', 'ошибка', 'hata', 'hatalı', 'lỗi']],
  ['bug',         ['バグ', '缺陷', '버그', 'issue', 'defect', 'خلل', 'اشکال', 'बग']],
  ['fix',         ['修正', '修复', '수정', 'bugfix', 'patch', 'hotfix', 'إصلاح', 'תיקון', 'رفع', 'सुधार', 'beheben', 'behoben', 'réparer', 'correction', 'arreglar', 'corrección', 'correggere', 'corrigir', 'исправить', 'исправление', 'düzeltmek', 'düzeltme']],
  ['build',       ['ビルド', '构建', '빌드', 'بناء', 'בנייה', 'ساخت', 'निर्माण', 'bauen', 'construire', 'construir', 'costruire', 'сборка', 'собрать', 'derleme', 'derlemek']],
  ['test',        ['テスト', '测试', '테스트', 'اختبار', 'בדיקה', 'آزمایش', 'परीक्षण', 'testen', 'tester', 'probar', 'testare', 'testar', 'тест', 'тестирование', 'test', 'testlemek']],
  ['auth',        ['認証', '认证', '인증', 'authentication', 'login', 'oauth', 'مصادقة', 'אימות', 'احراز هویت', 'प्रमाणीकरण', 'authentifizierung', 'authentification', 'autenticación', 'autenticazione', 'autenticação', 'аутентификация', 'авторизация', 'kimlik doğrulama', 'yetkilendirme']],
  ['authentication', ['auth', 'مصادقة', 'אימות', 'احراز هویت', 'प्रमाणीकरण', '認証', '认证', '인증', 'login', 'oauth', 'аутентификация', 'авторизация', 'kimlik doğrulama']],
  ['environment', ['環境', '环境', '환경', 'env', 'بيئة', 'סביבה', 'umgebung', 'environnement', 'entorno', 'ambiente', 'среда', 'окружение', 'ortam']],
  ['secret',      ['key', 'token', 'password', 'jwt', 'مفتاح', 'מפתח', 'geheimnis', 'schlüssel', 'clave', 'clé', 'chiave', 'chave', 'секрет', 'ключ', 'gizli', 'anahtar']],
  ['problem',     ['error', 'issue', 'bug', 'failure', 'مشكلة', '問題', '오류', 'fehler', 'problème', 'problema', 'проблема', 'ошибка', 'sorun', 'problem']],
  ['kubernetes',  ['クベルネテス', 'k8s', 'kube']],
  ['network',     ['ネットワーク', '网络', '네트워크', 'شبكة', 'רשת', 'شبکه', 'नेटवर्क', 'netzwerk', 'réseau', 'red', 'rete', 'rede', 'сеть', 'ağ']],
  ['timeout',     ['タイムアウト', '超时', '타임아웃', 'مهلة']],
  ['memory',      ['メモリ', '内存', '메모리', 'ram', 'ذاكرة', 'זיכרון', 'حافظه', 'मेमोरी', 'speicher', 'mémoire', 'memoria', 'memória', 'память', 'bellek', 'hafıza']],
  ['config',      ['設定', '配置', '설정', 'configuration', 'settings', 'conf', 'إعدادات', 'הגדרות', 'پیکربندی', 'कॉन्फ़िग', 'konfiguration', 'einstellungen', 'configuración', 'configurazione', 'configuração', 'конфигурация', 'настройки', 'yapılandırma', 'ayarlar']],
  ['install',     ['インストール', '安装', '설치', 'تثبيت', 'התקנה', 'نصب', 'इंस्टॉल', 'installieren', 'installer', 'instalar', 'installare', 'установить', 'установка', 'yüklemek', 'kurulum']],
  ['update',      ['アップデート', '更新', '업데이트', 'upgrade', 'تحديث', 'עדכון', 'به‌روزرسانی', 'अपडेट', 'aktualisieren', 'aktualisierung', 'actualizar', 'aggiornare', 'atualizar', 'обновление', 'обновить', 'güncelleme']],
  ['log',         ['ログ', '日志', '로그', 'logging', 'سجل', 'יומן', 'ثبت', 'लॉग', 'protokoll', 'protokolle', 'journal', 'registro', 'журнал', 'лог', 'günlük']],
  ['port',        ['ポート', '端口', '포트', 'منفذ', 'פורט']],
  ['file',        ['ファイル', '文件', '파일', 'ملف', 'קובץ']],
  ['image',       ['イメージ', '镜像', '이미지', 'صورة', 'תמונה', 'abbild', 'imagen', 'imagem']],
  ['volume',      ['ボリューム', '卷', '볼륨']],
  ['cluster',     ['クラスター', '集群', '클러스터']],
  ['node',        ['ノード', '节点', '노드']],
  ['service',     ['サービス', '服务', '서비스', 'svc', 'خدمة', 'שירות', 'dienst', 'servicio', 'servizio', 'serviço', 'сервис', 'служба', 'servis', 'hizmet']],
  ['certificate', ['証明書', '证书', '인증서', 'cert', 'ssl', 'tls', 'شهادة', 'תעודה']],
  ['password',    ['パスワード', '密码', '비밀번호', 'passwd', 'pwd', 'كلمة المرور', 'סיסמה']],
  ['token',       ['トークン', '令牌', '토큰', 'jwt', 'secret', 'رمز', 'אסימון']],
  ['health',      ['ヘルス', '健康', '헬스', 'healthcheck', 'probe', 'صحة']],
  ['migration',   ['マイグレーション', '迁移', '마이그레이션', 'migrate', 'هجرة']],
  ['backup',      ['バックアップ', '备份', '백업', 'نسخ احتياطي', 'גיבוי', 'پشتیبان‌گیری', 'बैकअप', 'sicherung', 'sauvegarde', 'respaldo', 'cópia de segurança', 'резервная копия', 'резерв', 'yedekleme']],
  ['monitor',     ['モニター', '监控', '모니터링', 'monitoring', 'metrics', 'alert', 'مراقبة', 'ניטור', 'نظارت', 'निगरानी', 'überwachung', 'surveiller', 'monitoreo', 'monitorare', 'monitorar', 'мониторинг', 'наблюдение', 'izleme']],
  ['performance', ['パフォーマンス', '性能', '성능', 'latency', 'throughput', 'عملکرد', 'प्रदर्शन', 'leistung', 'performances', 'rendimiento', 'prestazioni', 'desempenho', 'производительность', 'быстродействие', 'performans']],
  ['connection',  ['接続', '连接', '연결', 'conn', 'socket', 'اتصال', 'חיבור', 'اتصال', 'कनेक्शन', 'verbindung', 'connexion', 'conexión', 'connessione', 'conexão']],
  ['queue',       ['キュー', '队列', '큐', 'طابور', 'warteschlange', 'file d\'attente', 'cola', 'coda', 'fila']],
  ['redis',       ['レディス', '레디스']],
  ['nginx',       ['エンジンエックス']],
  ['linux',       ['リナックス', 'لينكس']],
  ['api',         ['エーピーアイ', '接口', 'endpoint', 'واجهة برمجية', 'ממשק']],
  ['healthcheck', ['ヘルスチェック', 'health', 'probe', 'فحص الصحة']],
  ['loadbalancer',['ロードバランサー', '负载均衡', '로드밸런서', 'lb']],
  ['ssl',         ['tls', 'https', 'certificate', 'cert']],
  ['tls',         ['ssl', 'https', 'certificate', 'cert']],
  ['docker',      ['container', 'コンテナ', '容器', '컨테이너', 'دوكر']],
  ['git',         ['version control', 'repo', 'repository', 'commit', 'push', 'pull']],
  ['ci',          ['pipeline', 'github actions', 'gitlab', 'jenkins', 'build']],
  ['cd',          ['deploy', 'deployment', 'release']],
  ['debug',       ['デバッグ', '调试', '디버그', 'debugging', 'breakpoint', 'تصحيح', 'איתור באגים', 'اشکال‌زدایی', 'डीबग', 'debuggen', 'déboguer', 'depurar', 'отладка', 'дебаг', 'hata ayıklama']],
  ['crash',       ['クラッシュ', '崩溃', '크래시', 'panic', 'segfault', 'انهيار', 'קריסה', 'خرابی', 'क्रैश', 'absturz', 'panne', 'plantage', 'caída', 'falha', 'сбой', 'крэш', 'çökme', 'çöküş']],
  ['restart',     ['再起動', '重启', '재시작', 'reboot', 'إعادة تشغيل', 'הפעלה מחדש', 'راه‌اندازی مجدد', 'पुنरारंभ', 'neustart', 'redémarrer', 'reiniciar', 'riavviare']],
  ['permission',  ['権限', '权限', '권한', 'access', 'acl', 'chmod', 'صلاحية', 'הרשאה', 'مجوز', 'अनुमति', 'berechtigung', 'berechtigungen', 'permiso', 'permesso', 'permissão', 'разрешение', 'доступ', 'izin', 'yetki']],
  // Japanese katakana → English
  ['デプロイ',    ['deploy', 'deployment']],
  ['コンテナ',    ['container', 'docker']],
  ['サーバー',    ['server']],
  ['サーバ',      ['server']],
  ['データベース',['database', 'db']],
  ['キャッシュ',  ['cache']],
  ['エラー',      ['error', 'err']],
  ['バグ',        ['bug', 'issue']],
  ['ビルド',      ['build']],
  ['テスト',      ['test']],
  ['認証',        ['auth', 'authentication']],
  ['設定',        ['config', 'configuration']],
  ['インストール',['install']],
  ['アップデート',['update', 'upgrade']],
  ['ログ',        ['log', 'logs']],
  ['ポート',      ['port']],
  ['ファイル',    ['file']],
  ['イメージ',    ['image']],
  ['クラスター',  ['cluster']],
  ['ノード',      ['node']],
  ['サービス',    ['service']],
  ['パスワード',  ['password']],
  ['トークン',    ['token']],
  ['バックアップ',['backup']],
  ['モニター',    ['monitor', 'monitoring']],
  ['接続',        ['connection']],
  ['キュー',      ['queue']],
  ['ヘルスチェック',['healthcheck', 'health check', 'health']],
  ['ロードバランサー',['loadbalancer', 'load balancer']],
  ['デバッグ',    ['debug']],
  ['クラッシュ',  ['crash', 'panic']],
  ['再起動',      ['restart', 'reboot']],
  ['権限',        ['permission', 'access']],
  // Chinese → English
  ['部署',        ['deploy', 'deployment']],
  ['容器',        ['container', 'docker']],
  ['服务器',      ['server']],
  ['数据库',      ['database']],
  ['缓存',        ['cache']],
  ['错误',        ['error']],
  ['修复',        ['fix', 'bugfix']],
  ['构建',        ['build']],
  ['测试',        ['test']],
  ['认证',        ['auth']],
  ['配置',        ['config']],
  ['安装',        ['install']],
  ['更新',        ['update']],
  ['日志',        ['log']],
  ['端口',        ['port']],
  ['镜像',        ['image']],
  ['集群',        ['cluster']],
  ['节点',        ['node']],
  ['服务',        ['service']],
  ['密码',        ['password']],
  ['令牌',        ['token']],
  ['备份',        ['backup']],
  ['监控',        ['monitor']],
  ['连接',        ['connection']],
  ['队列',        ['queue']],
  ['性能',        ['performance']],
  ['内存',        ['memory']],
  ['调试',        ['debug']],
  ['崩溃',        ['crash']],
  ['重启',        ['restart']],
  ['权限',        ['permission']],
  // Korean → English
  ['배포',        ['deploy', 'deployment']],
  ['컨테이너',    ['container']],
  ['서버',        ['server']],
  ['데이터베이스',['database']],
  ['캐시',        ['cache']],
  ['오류',        ['error']],
  ['수정',        ['fix']],
  ['빌드',        ['build']],
  ['테스트',      ['test']],
  ['인증',        ['auth']],
  ['설정',        ['config']],
  ['설치',        ['install']],
  ['업데이트',    ['update']],
  ['로그',        ['log']],
  ['포트',        ['port']],
  ['이미지',      ['image']],
  ['클러스터',    ['cluster']],
  ['노드',        ['node']],
  ['서비스',      ['service']],
  ['토큰',        ['token']],
  ['백업',        ['backup']],
  ['모니터링',    ['monitor']],
  ['연결',        ['connection']],
  ['큐',          ['queue']],
  ['성능',        ['performance']],
  ['메모리',      ['memory']],
  ['디버그',      ['debug']],
  ['크래시',      ['crash']],
  ['재시작',      ['restart']],
  ['권한',        ['permission']],
  // Arabic → English
  ['خطأ',              ['error']],
  ['إصلاح',            ['fix']],
  ['بناء',             ['build']],
  ['اختبار',           ['test']],
  ['مصادقة',           ['auth', 'authentication']],
  ['إعدادات',          ['config', 'configuration']],
  ['تثبيت',            ['install']],
  ['تحديث',            ['update', 'upgrade']],
  ['سجل',              ['log']],
  ['صورة',             ['image']],
  ['خدمة',             ['service']],
  ['نسخ احتياطي',      ['backup']],
  ['مراقبة',           ['monitor', 'monitoring']],
  ['اتصال',            ['connection']],
  ['ذاكرة',            ['memory']],
  ['تصحيح',            ['debug', 'debugging']],
  ['شبكة',             ['network']],
  // Additional Arabic → English (covering blog post examples + common terms)
  ['نشر',              ['deploy', 'deployment']],
  ['انهيار',           ['crash', 'panic']],
  ['طابور',            ['queue']],
  ['رمز',              ['token', 'secret']],
  ['كاش',              ['cache']],
  ['منفذ',             ['port']],
  ['سيرفر',            ['server']],
  ['قاعدة البيانات',   ['database', 'db']],
  ['إعادة تشغيل',      ['restart', 'reboot']],
  ['صلاحية',           ['permission', 'access']],
  ['تطبيق',            ['application', 'app']],
  ['مفتاح',            ['key', 'token', 'secret']],
  ['واجهة برمجية',     ['api', 'interface']],
  ['فحص الصحة',        ['healthcheck', 'health']],
  ['حاوية',            ['container', 'docker']],
  ['عقدة',             ['node']],
  ['سرعة',             ['performance', 'speed']],
  ['قرص',              ['disk', 'storage']],
  ['خادم',             ['server']],
  ['برنامج',           ['application', 'software', 'app']],
  // Arabic terms from blog examples
  ['مشكلة',            ['error', 'issue', 'bug', 'problem', 'failure']],
  ['بيئة',             ['environment', 'env']],
  ['متغيرات',          ['variables', 'env', 'environment']],
  ['إنتاج',            ['production', 'prod']],
  ['سري',              ['secret', 'key', 'token']],
  ['مفتاح سري',        ['secret', 'key']],
  // Hebrew → English
  ['שגיאה',            ['error']],
  ['תיקון',            ['fix']],
  ['בנייה',            ['build']],
  ['בדיקה',            ['test']],
  ['אימות',            ['auth', 'authentication']],
  ['הגדרות',           ['config', 'configuration']],
  ['התקנה',            ['install']],
  ['עדכון',            ['update', 'upgrade']],
  ['יומן',             ['log']],
  ['שרת',              ['server']],
  ['שירות',            ['service']],
  ['גיבוי',            ['backup']],
  ['ניטור',            ['monitor', 'monitoring']],
  ['חיבור',            ['connection']],
  ['זיכרון',           ['memory']],
  ['רשת',              ['network']],
  ['תמונה',            ['image']],
  ['סיסמה',            ['password']],
  ['הרשאה',            ['permission', 'access']],
  // Additional Hebrew → English (covering blog post examples + common terms)
  ['קריסה',            ['crash', 'panic']],
  ['תור',              ['queue']],
  ['מטמון',            ['cache']],
  ['אסימון',           ['token', 'secret']],
  ['פורט',             ['port']],
  ['איתור באגים',      ['debug', 'debugging']],
  ['הפעלה מחדש',       ['restart', 'reboot']],
  ['מיכל',             ['container', 'docker']],
  ['יישום',            ['application', 'app']],
  ['מפתח',             ['key', 'token', 'secret']],
  ['בדיקת תקינות',     ['healthcheck', 'health']],
  ['ממשק תכנות',       ['api', 'interface']],
  ['ביצועים',          ['performance']],
  ['אחסון',            ['storage', 'disk']],
  // Hebrew terms from blog examples
  ['פריסה',            ['deploy', 'deployment']],
  ['בעיה',             ['error', 'issue', 'bug', 'problem']],
  ['סביבה',            ['environment', 'env']],
  ['ייצור',            ['production', 'prod']],
  ['סודי',             ['secret', 'key', 'token']],
  ['מפתח סודי',        ['secret', 'key']],

  // ── Farsi/Persian → English ───────────────────────────────────────────────
  ['استقرار',          ['deploy', 'deployment']],
  ['خطا',              ['error', 'err']],         // Farsi: خطا  vs Arabic: خطأ
  ['اشکال',            ['bug', 'issue', 'error']],
  ['رفع اشکال',        ['fix', 'debug', 'debugging']],
  ['ساخت',             ['build']],
  ['آزمایش',           ['test']],
  ['احراز هویت',       ['auth', 'authentication']],
  ['پیکربندی',         ['config', 'configuration']],
  ['نصب',              ['install']],
  ['به‌روزرسانی',      ['update', 'upgrade']],
  ['ثبت',              ['log']],
  ['سرور',             ['server']],
  ['پایگاه داده',      ['database', 'db']],
  ['شبکه',             ['network']],              // Farsi شبکه vs Arabic شبكة
  ['حافظه',            ['memory', 'ram']],        // Farsi حافظه vs Arabic ذاكرة
  ['کش',               ['cache']],
  ['اشکال‌زدایی',      ['debug', 'debugging']],
  ['خرابی',            ['crash', 'failure', 'error']],
  ['راه‌اندازی مجدد',  ['restart', 'reboot']],
  ['مجوز',             ['permission', 'access']],
  ['پشتیبان‌گیری',     ['backup']],
  ['عملکرد',           ['performance']],
  ['مشکل',             ['problem', 'issue', 'error']],
  ['سرویس',            ['service']],
  ['کلید',             ['key', 'token', 'secret']],
  ['محیط',             ['environment', 'env']],
  ['تولید',            ['production', 'prod']],
  ['رمز',              ['secret', 'key', 'token']],
  ['اتصال',            ['connection', 'conn']],

  // ── Hindi (Devanagari) → English ──────────────────────────────────────────
  ['तैनाती',           ['deploy', 'deployment']],
  ['तैना',             ['deploy', 'deployment']],  // stemmed form
  ['त्रुटि',           ['error', 'err']],
  ['गलती',             ['error', 'bug', 'issue']],
  ['सुधार',            ['fix', 'bugfix']],
  ['निर्माण',          ['build']],
  ['परीक्षण',          ['test']],
  ['प्रमाणीकरण',       ['auth', 'authentication']],
  ['विन्यास',          ['config', 'configuration']],
  ['कॉन्फ़िगरेशन',     ['config', 'configuration']],
  ['इंस्टॉल',          ['install']],
  ['अपडेट',            ['update', 'upgrade']],
  ['लॉग',              ['log']],
  ['सर्वर',            ['server']],
  ['डेटाबेस',          ['database', 'db']],
  ['नेटवर्क',          ['network']],
  ['मेमोरी',           ['memory', 'ram']],
  ['कैश',              ['cache']],
  ['डीबग',             ['debug', 'debugging']],
  ['क्रैश',            ['crash', 'panic']],
  ['पुनरारंभ',         ['restart', 'reboot']],
  ['अनुमति',           ['permission', 'access']],
  ['बैकअप',            ['backup']],
  ['प्रदर्शन',         ['performance']],
  ['समस्या',           ['problem', 'issue', 'error']],
  ['सेवा',             ['service']],
  ['कनेक्शन',          ['connection', 'conn']],
  ['पासवर्ड',          ['password']],
  ['टोकन',             ['token', 'secret']],
  ['वातावरण',          ['environment', 'env']],
  ['उत्पादन',          ['production', 'prod']],

  // ── European languages → English ─────────────────────────────────────────
  // German (Deutsch) → English
  ['fehler',          ['error', 'err']],
  ['absturz',         ['crash', 'panic']],
  ['bug',             ['bug', 'issue']],  // same word, keep for completeness
  ['beheben',         ['fix', 'bugfix']],
  ['behoben',         ['fix', 'fixed']],
  ['lösung',          ['solution', 'fix']],
  ['bauen',           ['build']],
  ['testen',          ['test']],
  ['authentifizierung',['auth', 'authentication']],
  ['konfiguration',   ['config', 'configuration']],
  ['einstellungen',   ['config', 'settings']],
  ['installieren',    ['install']],
  ['installiert',     ['install', 'installed']],
  ['aktualisieren',   ['update', 'upgrade']],
  ['aktualisierung',  ['update', 'upgrade']],
  ['protokoll',       ['log']],
  ['protokolle',      ['log', 'logs']],
  ['abbild',          ['image']],
  ['knoten',          ['node']],
  ['dienst',          ['service']],
  ['sicherung',       ['backup']],
  ['überwachung',     ['monitor', 'monitoring']],
  ['verbindung',      ['connection', 'conn']],
  ['warteschlange',   ['queue']],
  ['leistung',        ['performance']],
  ['speicher',        ['memory', 'storage']],
  ['debuggen',        ['debug', 'debugging']],
  ['neustart',        ['restart', 'reboot']],
  ['berechtigung',    ['permission', 'access']],
  ['berechtigungen',  ['permission', 'access', 'acl']],
  ['netzwerk',        ['network']],
  ['datenbank',       ['database', 'db']],
  ['bereitstellen',   ['deploy', 'deployment']],
  ['bereitstellung',  ['deploy', 'deployment']],
  // 'container' and 'server' are the same in German/French/Spanish/Italian/Portuguese
  ['kaputt',          ['broken', 'error', 'crash']],
  ['funktioniert',    ['works', 'working']],
  ['geht nicht',      ['not working', 'broken', 'error']],
  ['schlüssel',       ['key', 'token', 'secret']],
  ['zertifikat',      ['certificate', 'cert', 'ssl', 'tls']],
  ['umgebung',        ['environment', 'env']],
  ['variablen',       ['variables', 'env', 'environment']],
  ['aufgabe',         ['task', 'job']],
  ['wartung',         ['maintenance']],
  ['speicherleck',    ['memory leak', 'memory']],
  ['schnittstelle',   ['interface', 'api']],

  // French (Français) → English
  ['erreur',          ['error', 'err']],
  ['réparer',         ['fix']],
  ['correction',      ['fix', 'bugfix']],
  ['construire',      ['build']],
  ['tester',          ['test']],
  ['authentification',['auth', 'authentication']],
  ['configuration',   ['config', 'configuration']],
  ['installer',       ['install']],
  ['installation',    ['install']],
  ['mettre',          ['update', 'upgrade']],
  ['journal',         ['log', 'logs']],
  ['nœud',            ['node']],
  ['sauvegarde',      ['backup']],
  ['surveiller',      ['monitor', 'monitoring']],
  ['connexion',       ['connection']],
  ['mémoire',         ['memory']],
  ['déboguer',        ['debug']],
  ['redémarrer',      ['restart', 'reboot']],
  ['réseau',          ['network']],
  ['base de données', ['database', 'db']],
  ['déployer',        ['deploy']],
  ['déploiement',     ['deploy', 'deployment']],
  ['clé',             ['key', 'token']],
  ['certificat',      ['certificate', 'cert', 'ssl']],
  ['environnement',   ['environment', 'env']],
  ['panne',           ['crash', 'outage', 'failure']],
  ['plantage',        ['crash', 'panic']],
  ['interface',       ['interface', 'api']],
  ['performances',    ['performance']],
  ['stockage',        ['storage', 'disk']],
  ['file attente',    ['queue']],

  // Spanish (Español) → English
  ['arreglar',        ['fix']],
  ['corrección',      ['fix', 'bugfix']],
  ['construir',       ['build']],
  ['probar',          ['test']],
  ['autenticación',   ['auth', 'authentication']],
  ['configuración',   ['config', 'configuration']],
  ['instalar',        ['install']],
  ['actualizar',      ['update', 'upgrade']],
  ['actualización',   ['update', 'upgrade']],
  ['registro',        ['log', 'registry']],
  ['nodo',            ['node']],
  ['servicio',        ['service']],
  ['contraseña',      ['password']],
  ['copia de seguridad',['backup']],
  ['respaldo',        ['backup']],
  ['monitorear',      ['monitor']],
  ['monitoreo',       ['monitoring']],
  ['conexión',        ['connection']],
  ['rendimiento',     ['performance']],
  ['memoria',         ['memory']],
  ['depurar',         ['debug']],
  ['fallo',           ['crash', 'failure', 'error']],
  ['caída',           ['crash', 'outage']],
  ['reiniciar',       ['restart', 'reboot']],
  ['permiso',         ['permission']],
  ['permisos',        ['permission', 'access']],
  ['red',             ['network']],
  ['base de datos',   ['database', 'db']],
  ['desplegar',       ['deploy']],
  ['despliegue',      ['deploy', 'deployment']],
  ['clave',           ['key', 'token', 'secret']],
  ['certificado',     ['certificate', 'cert', 'ssl']],
  ['entorno',         ['environment', 'env']],
  ['cola',            ['queue']],
  ['interfaz',        ['interface', 'api']],
  ['imagen',          ['image']],

  // Italian (Italiano) → English
  ['errore',          ['error', 'err']],
  ['correggere',      ['fix']],
  ['costruire',       ['build']],
  ['testare',         ['test']],
  ['autenticazione',  ['auth', 'authentication']],
  ['configurazione',  ['config', 'configuration']],
  ['installare',      ['install']],
  ['aggiornare',      ['update', 'upgrade']],
  ['aggiornamento',   ['update', 'upgrade']],
  ['registro',        ['log']],
  ['nodo',            ['node']],
  ['servizio',        ['service']],
  ['password',        ['password']],
  ['backup',          ['backup']],
  ['monitorare',      ['monitor']],
  ['connessione',     ['connection']],
  ['prestazioni',     ['performance']],
  ['memoria',         ['memory']],
  ['debug',           ['debug']],
  ['arresto anomalo', ['crash']],
  ['riavviare',       ['restart']],
  ['permesso',        ['permission']],
  ['rete',            ['network']],
  ['database',        ['database', 'db']],
  ['distribuire',     ['deploy']],
  ['distribuzione',   ['deploy', 'deployment']],
  ['chiave',          ['key', 'token', 'secret']],
  ['certificato',     ['certificate', 'cert']],
  ['ambiente',        ['environment', 'env']],
  ['coda',            ['queue']],
  ['immagine',        ['image']],

  // Portuguese (Português) → English
  ['erro',            ['error', 'err']],
  ['corrigir',        ['fix']],
  ['construir',       ['build']],
  ['testar',          ['test']],
  ['autenticação',    ['auth', 'authentication']],
  ['configuração',    ['config', 'configuration']],
  ['instalar',        ['install']],
  ['atualizar',       ['update', 'upgrade']],
  ['atualização',     ['update', 'upgrade']],
  ['registro',        ['log']],
  ['nó',              ['node']],
  ['serviço',         ['service']],
  ['senha',           ['password']],
  ['cópia de segurança',['backup']],
  ['monitorar',       ['monitor']],
  ['conexão',         ['connection']],
  ['desempenho',      ['performance']],
  ['memória',         ['memory']],
  ['depurar',         ['debug']],
  ['falha',           ['crash', 'failure', 'error']],
  ['reiniciar',       ['restart']],
  ['permissão',       ['permission']],
  ['rede',            ['network']],
  ['banco de dados',  ['database', 'db']],
  ['implantar',       ['deploy']],
  ['implantação',     ['deploy', 'deployment']],
  ['chave',           ['key', 'token', 'secret']],
  ['certificado',     ['certificate', 'cert']],
  ['ambiente',        ['environment', 'env']],
  ['fila',            ['queue']],
  ['imagem',          ['image']],

  // ── Russian (Cyrillic) → English ──────────────────────────────────────────
  ['ошибка',          ['error', 'err']],
  ['ошибки',          ['error', 'err']],
  ['сбой',            ['crash', 'failure', 'error']],
  ['крэш',            ['crash', 'panic']],
  ['баг',             ['bug', 'issue']],
  ['исправить',       ['fix', 'bugfix']],
  ['исправление',     ['fix', 'patch']],
  ['сборка',          ['build']],
  ['собрать',         ['build']],
  ['тест',            ['test']],
  ['тестирование',    ['test', 'testing']],
  ['аутентификация',  ['auth', 'authentication']],
  ['авторизация',     ['auth', 'authorization']],
  ['конфигурация',    ['config', 'configuration']],
  ['настройки',       ['config', 'settings']],
  ['установить',      ['install']],
  ['установка',       ['install']],
  ['обновление',      ['update', 'upgrade']],
  ['обновить',        ['update', 'upgrade']],
  ['журнал',          ['log']],
  ['лог',             ['log', 'logs']],
  ['сервер',          ['server']],
  ['база данных',     ['database', 'db']],
  ['сеть',            ['network']],
  ['память',          ['memory', 'ram']],
  ['кэш',             ['cache']],
  ['отладка',         ['debug', 'debugging']],
  ['перезапуск',      ['restart', 'reboot']],
  ['перезагрузка',    ['restart', 'reboot']],
  ['разрешение',      ['permission', 'access']],
  ['доступ',          ['permission', 'access']],
  ['резерв',          ['backup']],
  ['производительность', ['performance']],
  ['проблема',        ['problem', 'issue', 'error']],
  ['сервис',          ['service']],
  ['служба',          ['service']],
  ['подключение',     ['connection', 'conn']],
  ['соединение',      ['connection', 'conn']],
  ['развёртывание',   ['deploy', 'deployment']],
  ['развертывание',   ['deploy', 'deployment']],
  ['развёрт',         ['deploy', 'deployment']],  // stemmed form
  ['разверт',         ['deploy', 'deployment']],  // stemmed form
  ['контейнер',       ['container', 'docker']],
  ['образ',           ['image']],
  ['кластер',         ['cluster']],
  ['узел',            ['node']],
  ['секрет',          ['secret', 'key', 'token']],
  ['ключ',            ['key', 'token', 'secret']],
  ['пароль',          ['password']],
  ['токен',           ['token', 'secret']],
  ['мониторинг',      ['monitor', 'monitoring']],
  ['наблюдение',      ['monitor', 'monitoring']],
  ['мигрировать',     ['migrate', 'migration']],
  ['миграция',        ['migrate', 'migration']],

  // ── Turkish (Latin + special chars ğ/ş/ı) → English ─────────────────────
  ['hata',            ['error', 'err']],
  ['hatalı',          ['error', 'err']],
  ['çökme',           ['crash', 'panic']],
  ['çöküş',           ['crash', 'failure']],
  ['düzeltmek',       ['fix', 'bugfix']],
  ['düzeltme',        ['fix', 'patch']],
  ['derleme',         ['build']],
  ['derlemek',        ['build']],
  ['test',            ['test']],
  ['testlemek',       ['test', 'testing']],
  ['kimlik doğrulama',['auth', 'authentication']],
  ['yetkilendirme',   ['auth', 'authorization']],
  ['yapılandırma',    ['config', 'configuration']],
  ['ayarlar',         ['config', 'settings']],
  ['yüklemek',        ['install']],
  ['kurulum',         ['install']],
  ['güncelleme',      ['update', 'upgrade']],
  ['günlük',          ['log']],
  ['sunucu',          ['server']],
  ['veritabanı',      ['database', 'db']],
  ['ağ',              ['network']],
  ['bellek',          ['memory', 'ram']],
  ['önbellek',        ['cache']],
  ['hata ayıklama',   ['debug', 'debugging']],
  ['yeniden başlatma',['restart', 'reboot']],
  ['izin',            ['permission', 'access']],
  ['yetki',           ['permission', 'access', 'acl']],
  ['yedekleme',       ['backup']],
  ['performans',      ['performance']],
  ['sorun',           ['problem', 'issue', 'error']],
  ['servis',          ['service']],
  ['hizmet',          ['service']],
  ['bağlantı',        ['connection', 'conn']],
  ['dağıtım',         ['deploy', 'deployment']],
  ['dağıtmak',        ['deploy']],
  ['konteyner',       ['container', 'docker']],
  ['küme',            ['cluster']],
  ['düğüm',           ['node']],
  ['gizli',           ['secret', 'key']],
  ['anahtar',         ['key', 'token', 'secret']],
  ['şifre',           ['password']],
  ['izleme',          ['monitor', 'monitoring']],
  ['göç',             ['migrate', 'migration']],

  // ── Vietnamese (Latin + Latin Extended Additional U+1EA0–U+1EF9) → English ─
  ['triển khai',      ['deploy', 'deployment']],
  ['triển',           ['deploy', 'deployment']],  // split token form
  ['lỗi',             ['error', 'err']],
  ['sửa lỗi',         ['fix', 'bugfix', 'debug']],
  ['xây dựng',        ['build']],
  ['kiểm tra',        ['test']],
  ['xác thực',        ['auth', 'authentication']],
  ['cấu hình',        ['config', 'configuration']],
  ['cài đặt',         ['install']],
  ['cập nhật',        ['update', 'upgrade']],
  ['nhật ký',         ['log']],
  ['máy chủ',         ['server']],
  ['cơ sở dữ liệu',   ['database', 'db']],
  ['mạng',            ['network']],
  ['bộ nhớ',          ['memory', 'ram']],
  ['bộ đệm',          ['cache']],
  ['gỡ lỗi',          ['debug', 'debugging']],
  ['sự cố',           ['crash', 'failure', 'error']],
  ['khởi động lại',   ['restart', 'reboot']],
  ['quyền',           ['permission', 'access']],
  ['sao lưu',         ['backup']],
  ['hiệu suất',       ['performance']],
  ['vấn đề',          ['problem', 'issue', 'error']],
  ['dịch vụ',         ['service']],
  ['kết nối',         ['connection', 'conn']],
  ['vùng chứa',       ['container', 'docker']],
  ['nút',             ['node']],
  ['khóa',            ['key', 'token', 'secret']],
  ['mật khẩu',        ['password']],
  ['giám sát',        ['monitor', 'monitoring']],
  ['di chuyển',       ['migrate', 'migration']],
]);

/**
 * Expand a token to its cross-lingual synonyms.
 * Returns synonyms to be added to the token stream (pre-tokenized).
 * CJK synonyms are NOT pre-bigram'd here — caller handles that.
 */
function expandCrossLingual(token: string): string[] {
  return CROSS_LINGUAL_MAP.get(token) ?? [];
}

/**
 * Tokenize text into meaningful keywords.
 * Handles accented Latin, RTL (Arabic, Hebrew), and CJK (Chinese, Japanese, Korean).
 *
 * Features:
 *  • CJK → character bigrams
 *  • Katakana → additionally emits Hepburn romaji tokens (enables romaji queries)
 *  • Arabic  → word tokenization + iterative prefix stemming (ال/و/ب/ل/ف/ك)
 *  • Hebrew  → word tokenization + iterative prefix stemming (ה/ו/ב/ל/מ/כ)
 *  • Farsi   → word tokenization + suffix/prefix stemming (ها/های plural, می prefix)
 *  • Hindi   → Devanagari word tokenization + light suffix stemming
 *  • All scripts → cross-lingual synonym expansion (EN↔JA↔ZH↔KO↔AR↔HE↔FA↔HI↔DE↔FR↔ES↔IT↔PT)
 */
/**
 * Tokenize text for BM25 indexing or query expansion.
 *
 * @param text - The text to tokenize
 * @param options.crossLingualExpand - When true (default), adds cross-lingual synonym
 *   tokens for every base token. Set to false when indexing DOCUMENTS so that
 *   English documents don't get indexed with all Arabic/Japanese/etc. synonyms of
 *   every word they contain — that inflates BM25 scores catastrophically when a query
 *   also expands the same term. Query tokenization keeps expansion enabled so a
 *   Japanese query still finds English documents (query "デプロイ" → expands to "deploy").
 */
function tokenize(text: string, options?: { crossLingualExpand?: boolean }): string[] {
  const doCrossLingualExpand = options?.crossLingualExpand ?? true;
  const tokens: string[] = [];
  // Pre-process: split camelCase/PascalCase identifiers and snake_case before lowercasing
  const lower = preprocessText(text).toLowerCase();

  for (const [seg] of lower.matchAll(SEGMENT_RE)) {
    if (CJK_RE.test(seg)) {
      // CJK segment — extract overlapping character bigrams
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg[i] + seg[i + 1];
        if (!STOPWORDS.has(seg[i]) && !STOPWORDS.has(bigram)) {
          tokens.push(bigram);
        }
      }
      // Trailing single character (for 1-char CJK terms)
      if (seg.length >= 1) {
        const last = seg[seg.length - 1];
        if (!STOPWORDS.has(last)) tokens.push(last);
      }
      // Whole-segment cross-lingual lookup (for known tech terms like デプロイ, 部署, 배포)
      // This ensures CJK full-words map to their English equivalents
      const segSyns = expandCrossLingual(seg);
      for (const syn of segSyns) {
        if (!CJK_RE.test(syn)) {
          syn.split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w)).forEach(w => tokens.push(w));
        }
      }
      // Romanization: extract katakana-only portion and emit romaji tokens.
      // This allows users to search "kontena" or "depuroi" to find katakana docs.
      const kataOnly = seg.replace(/[^\u30a0-\u30ff]/g, '');
      if (kataOnly.length >= 2) {
        const romaji = katakanaToRomaji(kataOnly);
        if (romaji.length >= 2 && romaji.length <= 40 && !STOPWORDS.has(romaji)) {
          tokens.push(romaji);
        }
      }
    } else if (RTL_RE.test(seg)) {
      // RTL segment — 3-way branch: Farsi / Hebrew / Arabic
      const words = seg.trim().split(/\s+/);
      let stemFn: (w: string) => string;
      if (FARSI_CHAR_RE.test(seg))       stemFn = farsiLightStem;
      else if (HEBREW_CHAR_RE.test(seg)) stemFn = hebrewLightStem;
      else                               stemFn = arabicLightStem;
      for (const w of words) {
        if (w.length <= 1 || STOPWORDS.has(w)) continue;
        const stemmed = stemFn(w);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (DEVANAGARI_RE.test(seg)) {
      // Devanagari segment (Hindi / Marathi) — naturally space-separated
      const words = seg.trim().split(/[\s\u200c\u200d]+/); // handle zero-width joiners
      for (const w of words) {
        const deva = w.replace(/[^\u0900-\u097f0-9]/g, '');
        if (deva.length <= 1 || STOPWORDS.has(deva)) continue;
        const stemmed = hindiLightStem(deva);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (BENGALI_RE.test(seg)) {
      // Bengali (Bangla) segment — space-separated words, Bengali script
      const words = seg.trim().split(/[\s\u200c\u200d]+/);
      for (const w of words) {
        const bn = w.replace(/[^\u0980-\u09ff0-9]/g, '');
        if (bn.length <= 1 || STOPWORDS.has(bn)) continue;
        const stemmed = bengaliLightStem(bn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (CYRILLIC_RE.test(seg)) {
      // Cyrillic segment (Russian, Bulgarian, Ukrainian, Serbian …)
      const words = seg.trim().split(/\s+/);
      for (const w of words) {
        const cyr = w.replace(/[^\u0400-\u04ff]/g, '');
        if (cyr.length <= 1 || STOPWORDS.has(cyr)) continue;
        const stemmed = russianLightStem(cyr);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else {
      // Latin / other — includes Turkish (ğ/ş/ı), Polish (ą/ę/ł/ń/ó/ś/ź/ż/ć),
      // Czech (č/š/ž/ě/ů/ř), Hungarian (ő/ű), Romanian (ș/ț), Vietnamese (ắặầổợụừ…)
      const words = seg
        .replace(/[^a-záàâãäåæçéèêëíìîïñóòôõöúùûüýÿßœğşıİąćęłńśźżčšžěůřőűșț\u1ea0-\u1ef90-9:\-./]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOPWORDS.has(w));
      // Turkish: apply light stemmer to words with Turkish-specific chars
      for (const w of words) {
        if (TURKISH_CHAR_RE.test(w)) {
          const stemmed = turkishLightStem(w);
          if (stemmed !== w && stemmed.length > 1 && !STOPWORDS.has(stemmed)) {
            tokens.push(stemmed);
          }
        }
        tokens.push(w);
      }
    }
  }

  // ── Cross-lingual expansion (query mode only) ────────────────────────────
  // Only run when tokenizing queries. Skipped for documents to prevent the
  // symmetric-expansion inflation bug: if both query and document expand "error"
  // to 28 synonyms, BM25 counts all 28 as exact matches — a single common word
  // inflates any document's score 28×, burying topic-specific matches.
  if (!doCrossLingualExpand) return tokens;

  // For each token, look up synonyms in other languages and add them.
  // CJK synonyms are bigram-expanded inline; Latin/RTL synonyms added as-is.
  const expansions: string[] = [];
  const seen = new Set(tokens);
  for (const tok of tokens) {
    const syns = expandCrossLingual(tok);
    for (const syn of syns) {
      if (seen.has(syn)) continue;
      seen.add(syn);
      if (CJK_RE.test(syn)) {
        // CJK synonym → expand to character bigrams
        for (let i = 0; i < syn.length - 1; i++) {
          const bg = syn[i] + syn[i + 1];
          if (!STOPWORDS.has(syn[i]) && !STOPWORDS.has(bg)) expansions.push(bg);
        }
        if (syn.length >= 1) {
          const last = syn[syn.length - 1];
          if (!STOPWORDS.has(last)) expansions.push(last);
        }
      } else if (RTL_RE.test(syn)) {
        // RTL synonym — apply correct stemmer per language
        const rtlStem = FARSI_CHAR_RE.test(syn) ? farsiLightStem
                      : HEBREW_CHAR_RE.test(syn) ? hebrewLightStem
                      : arabicLightStem;
        const stemmed = rtlStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (DEVANAGARI_RE.test(syn)) {
        // Devanagari synonym (Hindi)
        const stemmed = hindiLightStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (BENGALI_RE.test(syn)) {
        // Bengali synonym
        const stemmed = bengaliLightStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (CYRILLIC_RE.test(syn)) {
        // Cyrillic synonym (Russian)
        const cyr = syn.replace(/[^\u0400-\u04ff]/g, '');
        const stemmed = russianLightStem(cyr);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else {
        // Latin synonym (includes Turkish) — split in case of multi-word
        const parts = syn.split(/\s+/).filter(w => {
          if (w.length <= 1 || STOPWORDS.has(w)) return false;
          return true;
        });
        for (const p of parts) {
          expansions.push(p);
          // Apply Turkish stemmer if it has Turkish-specific characters
          if (TURKISH_CHAR_RE.test(p)) {
            const stemmed = turkishLightStem(p);
            if (stemmed !== p && stemmed.length > 1 && !STOPWORDS.has(stemmed)) {
              expansions.push(stemmed);
            }
          }
        }
      }
    }
  }
  tokens.push(...expansions);

  return tokens;
}

/**
 * Split a multi-topic query into sub-queries.
 * Detects numbered lists, semicolons, "and also", line breaks, etc.
 *
 * Example: "deploy API fix routing and also check auth" →
 *   ["deploy API fix routing", "check auth"]
 *
 * Example: "1. deploy 2. fix routing 3. auth" →
 *   ["deploy", "fix routing", "auth"]
 */
function splitMultiQuery(query: string): string[] {
  // Numbered list: "1. foo 2. bar 3. baz"
  const numberedParts = query.split(/\d+[.)]\s*/g).filter(s => s.trim().length > 2);
  if (numberedParts.length >= 2) return numberedParts.map(s => s.trim());

  // Semicolons or newlines
  const semiParts = query.split(/[;\n]+/).filter(s => s.trim().length > 2);
  if (semiParts.length >= 2) return semiParts.map(s => s.trim());

  // Conjunctions (EN + DE + FR + ES + IT + PT + RU + TR)
  const conjParts = query.split(
    /\b(?:and also|also noch|außerdem|plus|additionally|furthermore|de plus|además|inoltre|além disso|а также|и также|кроме того|плюс|ayrıca|bunun yanı sıra|همچنین|وأيضاً|وكذلك|وهمچنین|और भी|इसके अलावा)\b/i
  ).filter(s => s.trim().length > 2);
  if (conjParts.length >= 2) return conjParts.map(s => s.trim());

  // Comma-separated with 3+ parts (likely a list)
  const commaParts = query.split(/,\s*/).filter(s => s.trim().length > 2);
  if (commaParts.length >= 3) return commaParts.map(s => s.trim());

  // Single query
  return [query];
}

// ── BM25+ Scoring ─────────────────────────────────────────────────────────────
//
// BM25+ fixes the "long document under-scoring" bug in classic BM25.
// Paper: Lv & Zhai (2011) "Lower-Bounding Term Frequency Normalization"
//
// Improvements over standard BM25:
//   1. δ=1 additive term → guarantees TF>0 terms always contribute positively
//   2. Bigram proximity boost → adjacent query terms in doc get 2× weight
//   3. Recency boost → entries with timestamps get exp-decay bonus (7d half-life)
//   4. Levenshtein fuzzy match → typo-tolerant (distance ≤ 2)
//

/** BM25+ parameters */
const BM25_K1    = 1.2;   // term frequency saturation
const BM25_B     = 0.75;  // length normalization
const BM25_DELTA = 1.0;   // BM25+ lower-bound guarantee (0 = classic BM25)

/** Recency boost: half-life in days. Entry from 7 days ago gets 0.5× boost. */
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Zero-results query log — in-memory FIFO ring (max 500 entries).
 * Exposed via /health for observability. Never persisted.
 */
interface ZeroResultEntry { query: string; ts: number; }
const ZERO_RESULTS_LOG: ZeroResultEntry[] = [];
const ZERO_RESULTS_MAX = 500;
let zeroResultsTotal = 0;

function logZeroResult(query: string): void {
  zeroResultsTotal++;
  if (ZERO_RESULTS_LOG.length >= ZERO_RESULTS_MAX) ZERO_RESULTS_LOG.shift();
  ZERO_RESULTS_LOG.push({ query, ts: Date.now() });
}

/** Global index vocabulary — rebuilt on each keywordSearch call from the doc set. */
let _indexVocab: Set<string> = new Set();

interface DocEntry {
  key: string;
  content: string;
  tokens: string[];
  tokenFreq: Map<string, number>;  // term → count in this doc
  bigrams: Set<string>;            // "term1|term2" adjacency pairs
  keyTokens: Set<string>;          // tokens from key/title only (for title boost)
  timestamp?: number;              // epoch ms, extracted from content if present
}

interface KeywordMatch {
  key: string;
  content: string;
  score: number;
  matchedWords: string[];
  subQuery?: string;   // which sub-query matched (for multi-topic)
}

/**
 * Levenshtein distance — edit distance between two strings.
 * Used for typo-tolerant fuzzy matching (distance ≤ 2 = match).
 * O(n*m) but strings are short (tokens), so this is fast.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Skip if length diff > 2 (can't be ≤ 2 edits)
  if (Math.abs(a.length - b.length) > 2) return 3;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = i - 1;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const cur = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + cost);
      corner = prev[j];
      prev[j] = cur;
    }
  }
  return prev[b.length];
}

/** Extract a timestamp from JSON content (looks for "ts" or "created" fields). */
function extractTimestamp(content: string): number | undefined {
  // Fast regex for ISO dates in JSON: "ts":"2026-04-17T..." or "created":"..."
  const match = content.match(/"(?:ts|created|created_at|timestamp)"\s*:\s*"([^"]+)"/);
  if (match) {
    const ms = Date.parse(match[1]);
    if (!isNaN(ms)) return ms;
  }
  return undefined;
}

/** Recency multiplier: 1.0 for now, 0.5 after half-life days, exponential decay. */
// The GENTLE, ranking-only age curve — deliberately NOT the sharp staleness
// curve in confidence.ts (calculateConfidence). Ranking must nudge, not punish:
// a 7-day half-life bounded to [0.5,1.5] keeps a still-relevant older lesson in
// contention. This is bench-tuned; swapping in the sharp confidence curve here
// regressed every Cachly-Bench floor and was reverted (PR #228). If you touch
// this, run `npm run bench:gate` — the rerank.test.ts guard alone is too loose.
function recencyBoost(timestampMs: number | undefined): number {
  if (!timestampMs) return 1.0; // no timestamp → neutral
  const ageDays = (Date.now() - timestampMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.5; // future/just-now → max boost
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) + 0.5; // range: [0.5, 1.5]
}

/**
 * BM25+ with Bigram Proximity, Recency Boost, and Fuzzy Matching.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Query: "deploy API fix routing; check auth"                    │
 * │    ↓ splitMultiQuery                                            │
 * │  Sub-queries: ["deploy API fix routing", "check auth"]          │
 * │    ↓ for each sub-query                                         │
 * │  Tokenize → BM25+ score per doc → Bigram boost → Fuzzy match   │
 * │    ↓ merge & deduplicate                                        │
 * │  Recency boost → Sort → Top-K                                  │
 * └─────────────────────────────────────────────────────────────────┘
 */
async function keywordSearch(
  redis: Redis,
  patterns: string[],
  query: string,
  topK = 10,
): Promise<KeywordMatch[]> {
  // ── Step 1: Collect all matching keys — patterns scanned in parallel ──
  const keyBatches = await Promise.all(patterns.map(pattern => {
    const keys: string[] = [];
    const stream = redis.scanStream({ match: pattern, count: 500 });
    return new Promise<string[]>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        keys.push(...batch.filter((k: string) => !k.endsWith(':meta')));
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }));
  // Deduplicate across patterns (a key may match multiple globs)
  const allKeys = [...new Set(keyBatches.flat())];

  if (allKeys.length === 0) return [];

  // Pipeline GET for speed
  const pipeline = redis.pipeline();
  for (const key of allKeys) pipeline.get(key);
  const results = await pipeline.exec();

  const docs: DocEntry[] = [];
  let totalTokens = 0;

  for (let i = 0; i < allKeys.length; i++) {
    const content = results?.[i]?.[1] as string | null;
    if (!content) continue;

    const tokens = tokenize(`${allKeys[i]} ${content}`, { crossLingualExpand: false });
    if (tokens.length === 0) continue;

    // Term frequency map
    const tokenFreq = new Map<string, number>();
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    }

    // Bigrams — adjacent token pairs for proximity detection
    const bigrams = new Set<string>();
    for (let j = 0; j < tokens.length - 1; j++) {
      bigrams.add(`${tokens[j]}|${tokens[j + 1]}`);
    }

    const timestamp = extractTimestamp(content);
    // Key tokens for title-boost: terms appearing in the Redis key get extra weight
    const keyTokens = new Set(tokenize(allKeys[i]));
    docs.push({ key: allKeys[i], content, tokens, tokenFreq, bigrams, keyTokens, timestamp });
    totalTokens += tokens.length;
  }

  if (docs.length === 0) return [];
  const avgDL = totalTokens / docs.length;

  // ── Step 2: IDF (inverse document frequency) ──
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (!seen.has(t)) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
  }
  const N = docs.length;

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

  /**
   * Fuzzy match: tries exact → prefix → substring → Levenshtein ≤ 2.
   * Returns [matchedTerm, weight] or null.
   *
   * Weights:
   *  1.0 — exact match
   *  0.85 — doc token starts with query (e.g. "dockerf" → "dockerfile")
   *  0.75 — query starts with doc token (e.g. "kubernetes" → "kube")
   *  0.6  — substring (either direction)
   *  0.4  — Levenshtein ≤ 2 (typo tolerance)
   */
  function fuzzyMatch(qt: string, docTermSet: Set<string>): [string, number] | null {
    // Exact
    if (docTermSet.has(qt)) return [qt, 1.0];
    // Prefix: query is prefix of a doc token (user typed partial word)
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length > qt.length && dt.startsWith(qt)) return [dt, 0.85];
      }
    }
    // Reverse-prefix: doc token is prefix of query (doc has abbreviated form)
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length >= 4 && dt.length < qt.length && qt.startsWith(dt)) return [dt, 0.75];
      }
    }
    // Substring (partial)
    for (const dt of docTermSet) {
      if (dt.length > 3 && qt.length > 3 && (dt.includes(qt) || qt.includes(dt))) {
        return [dt, 0.6];
      }
    }
    // Levenshtein ≤ 2 (typo tolerance) — only for tokens ≥ 4 chars
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length >= 4 && levenshtein(qt, dt) <= 2) {
          return [dt, 0.4];
        }
      }
    }
    return null;
  }

  // ── Step 3: Score each sub-query independently ──
  const subQueries = splitMultiQuery(query);
  const allMatches = new Map<string, KeywordMatch>();

  for (const sq of subQueries) {
    const queryTokens = tokenize(sq);
    if (queryTokens.length === 0) continue;

    // Pre-compute query bigrams for proximity boost
    const queryBigrams = new Set<string>();
    for (let j = 0; j < queryTokens.length - 1; j++) {
      queryBigrams.add(`${queryTokens[j]}|${queryTokens[j + 1]}`);
    }

    for (const doc of docs) {
      let score = 0;
      const matchedWords: string[] = [];
      const docTermSet = new Set(doc.tokens);

      for (const qt of queryTokens) {
        // Try exact BM25+ first
        const exactScore = bm25PlusTerm(qt, doc);
        if (exactScore > 0) {
          score += exactScore;
          matchedWords.push(qt);
          continue;
        }
        // Fuzzy match (substring or Levenshtein)
        const fuzz = fuzzyMatch(qt, docTermSet);
        if (fuzz) {
          score += bm25PlusTerm(fuzz[0], doc) * fuzz[1];
          matchedWords.push(`~${qt}`);
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
      if (sq.length >= 4 && doc.content.toLowerCase().includes(sq.toLowerCase())) {
        score *= 2.0;
      }

      // Key/title boost: if query terms appear in the Redis key (=title), 1.5× boost
      // Keys often encode the primary topic (e.g. "deploy:api:server"), so key hits are high-precision.
      if (score > 0) {
        let keyHits = 0;
        for (const qt of queryTokens) {
          if (doc.keyTokens.has(qt)) keyHits++;
        }
        if (keyHits > 0) {
          score *= 1 + 0.5 * (keyHits / queryTokens.length);
        }
      }

      // Recency boost
      score *= recencyBoost(doc.timestamp);

      if (score > 0) {
        const existing = allMatches.get(doc.key);
        if (!existing || score > existing.score) {
          allMatches.set(doc.key, {
            key: doc.key,
            content: doc.content,
            score,
            matchedWords: [...new Set(matchedWords)],
            subQuery: subQueries.length > 1 ? sq : undefined,
          });
        }
      }
    }
  }

  // ── Step 4: Sort by score, return top-K ──
  const sorted = [...allMatches.values()].sort((a, b) => b.score - a.score);
  const topResults = sorted.slice(0, topK);

  // ── Step 5: Zero-results logging + Did-You-Mean ───────────────────────────
  if (topResults.length === 0) {
    logZeroResult(query);
    // Rebuild index vocab for Did-You-Mean suggestions
    _indexVocab = new Set<string>();
    for (const doc of docs) for (const t of doc.tokens) _indexVocab.add(t);
  }

  return topResults;
}

// ── Exported for testing ──────────────────────────────────────────────────────
export { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP };

// ── Exported for use in index.ts ──────────────────────────────────────────────
export type { KeywordMatch };
export { keywordSearch, ZERO_RESULTS_LOG, logZeroResult, _indexVocab as indexVocab, zeroResultsTotal };

