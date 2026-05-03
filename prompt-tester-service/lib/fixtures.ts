import type {
  ComboEntry,
  ConversationTurn,
  PromptTestCase,
  ScriptTopic,
  ScriptTurn,
  SignToken,
  SignTokenTopK,
} from "./types";
import {
  dictionaryLabel,
  validateFixtureVocabulary,
} from "./vocabulary";

export const DEFAULT_SYSTEM_PROMPT = `You are the SignChat reconstruction layer for a scripted, vocabulary-limited sign-to-voice demo.

Your priority order:
1. Match the COMBOS table first.
2. Confirm the candidate against recognized signs.
3. Use hearing transcript context only to resolve which combo is intended.
4. Fall back to script candidates only if the combo table is insufficient.

Return JSON only:
{
  "sentence": "string",
  "confidence": "high" | "medium" | "low",
  "matchedScriptId": "turn_XX" | null,
  "usedSigns": ["TOKEN"]
}

Confidence rules:
- high: all required combo signs are present and context supports the match.
- medium: context strongly supports a combo but one required sign is missing.
- low: no supported combo or token confidence is low.

If the result is low confidence or the context conflicts with the signs, use confidence "low".`;

export const DEFAULT_USER_TEMPLATE = `Reconstruct the intended sentence for this sign turn.

Recognized signs:
{{recognizedSigns}}

Recent hearing transcript:
{{hearingTranscript}}

Word dictionary:
{{dictionary}}

Script candidates:
{{scriptCandidates}}

Combination dictionary:
{{combos}}

Return the JSON object only.`;

// First-meeting casual conversation, ~40 turns spread across PopSign-friendly
// topics. Every signer token must be one of the 250 PopSign labels;
// validateFixtureVocabulary() at module load enforces that.
export const SCRIPT_TURNS: readonly ScriptTurn[] = [
  turn("turn_01", "greeting", "Hi there, it's nice to meet you.", ["HELLO"], "Hi, hello."),
  turn("turn_02", "greeting", "How are you doing today?", ["FINE", "THANKYOU"], "I'm fine, thank you."),
  turn("turn_03", "greeting", "Did you have a good morning?", ["YES", "MORNING", "FINE"], "Yes, my morning was fine."),
  turn("turn_04", "greeting", "Are you having a good day so far?", ["YES", "HAPPY"], "Yes, I'm happy."),

  turn("turn_05", "family", "Tell me about your family. Do you have any brothers?", ["HAVE", "BROTHER"], "I have a brother."),
  turn("turn_06", "family", "What about your parents?", ["MOM", "DAD", "HOME"], "My mom and dad are at home."),
  turn("turn_07", "family", "Do you spend time with your grandparents?", ["YES", "GRANDMA", "GRANDPA"], "Yes, with my grandma and grandpa."),
  turn("turn_08", "family", "Any aunts or uncles you're close to?", ["AUNT", "UNCLE"], "My aunt and uncle."),
  turn("turn_09", "family", "Do you have any kids of your own?", ["NO", "CHILD"], "No, I don't have a child."),

  turn("turn_10", "feelings", "How are you feeling right now?", ["HAPPY"], "I'm happy."),
  turn("turn_11", "feelings", "You look a little tired.", ["YES", "SLEEPY"], "Yes, I'm sleepy."),
  turn("turn_12", "feelings", "Is anything bothering you?", ["NOT", "MAD"], "I'm not mad."),
  turn("turn_13", "feelings", "Are you hungry yet?", ["YES", "HUNGRY", "THIRSTY"], "Yes, I'm hungry and thirsty."),

  turn("turn_14", "body", "Did you hurt yourself?", ["NO", "OWIE"], "No, no owie."),
  turn("turn_15", "body", "Can you see and hear me okay?", ["YES", "SEE", "EYE", "HEAR"], "Yes, I can see and hear you."),
  turn("turn_16", "body", "Did you brush your teeth this morning?", ["YES", "TOOTHBRUSH", "TOOTH"], "Yes, I brushed my teeth."),

  turn("turn_17", "home", "Where are you right now?", ["HOME", "BEDROOM"], "I'm at home in my bedroom."),
  turn("turn_18", "home", "Is the room quiet?", ["YES", "ROOM", "QUIET"], "Yes, the room is quiet."),
  turn("turn_19", "home", "Are you watching anything?", ["YES", "TV"], "Yes, I'm watching TV."),
  turn("turn_20", "home", "Did you find a place to sit?", ["YES", "CHAIR"], "Yes, I'm in the chair."),

  turn("turn_21", "food-drink", "Have you eaten anything yet?", ["YES", "SNACK"], "Yes, I had a snack."),
  turn("turn_22", "food-drink", "Do you want a drink?", ["YES", "WATER", "PLEASE"], "Yes, water please."),
  turn("turn_23", "food-drink", "What sounds good for lunch?", ["PIZZA"], "Pizza."),
  turn("turn_24", "food-drink", "Want something sweet?", ["YES", "ICECREAM"], "Yes, ice cream."),
  turn("turn_25", "food-drink", "Do you like apples?", ["LIKE", "APPLE"], "I like apples."),

  turn("turn_26", "clothing-color", "What color is your shirt?", ["BLUE"], "It's blue."),
  turn("turn_27", "clothing-color", "Did you put on a jacket?", ["YES", "JACKET"], "Yes, I put on a jacket."),
  turn("turn_28", "clothing-color", "What's your favorite color?", ["GREEN"], "Green."),

  turn("turn_29", "weather-outside", "How's the weather where you are?", ["SUN", "HOT"], "It's sunny and hot."),
  turn("turn_30", "weather-outside", "Is it raining?", ["NO", "CLOUD"], "No, just cloudy."),
  turn("turn_31", "weather-outside", "Want to go outside?", ["YES", "OUTSIDE", "BACKYARD"], "Yes, outside in the backyard."),
  turn("turn_32", "weather-outside", "Have you been to the pool?", ["YES", "POOL"], "Yes, the pool."),

  turn("turn_33", "animals", "Do you have any pets?", ["YES", "DOG", "CAT"], "Yes, a dog and a cat."),
  turn("turn_34", "animals", "What's your favorite animal?", ["HORSE"], "A horse."),
  turn("turn_35", "animals", "Have you seen birds today?", ["YES", "BIRD", "TREE"], "Yes, a bird in the tree."),
  turn("turn_36", "animals", "Are there fish in the pool?", ["NO", "FISH"], "No fish."),

  turn("turn_37", "daily-routine", "What time do you usually go to bed?", ["NIGHT", "BED"], "At night, in bed."),
  turn("turn_38", "daily-routine", "Do you read before bed?", ["YES", "READ", "BOOK"], "Yes, I read a book."),
  turn("turn_39", "daily-routine", "Did you take a shower today?", ["YES", "SHOWER"], "Yes, I took a shower."),
  turn("turn_40", "daily-routine", "When do you wake up?", ["WAKE", "MORNING"], "I wake up in the morning."),

  turn("turn_41", "goodbye", "Thanks for chatting with me.", ["THANKYOU"], "Thank you."),
  turn("turn_42", "goodbye", "Should we talk again tomorrow at the same time?", ["YES", "TOMORROW", "SAME", "TIME"], "Yes, tomorrow same time."),
  turn("turn_43", "goodbye", "Okay, talk to you later!", ["BYE", "LATER"], "Bye, talk later."),
] as const;

// Tokens that are too generic to anchor a combo on by themselves. The combo
// derivation prefers content tokens for `must` and demotes these to `optional`.
const HIGH_FREQ_STOPLIST: ReadonlySet<string> = new Set([
  "YES",
  "NO",
  "NOT",
  "ALL",
  "SAME",
  "NOW",
  "TIME",
  "HAVE",
]);

const ENGLISH_STOPLIST: ReadonlySet<string> = new Set([
  "a",
  "about",
  "an",
  "and",
  "any",
  "anything",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "get",
  "got",
  "had",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "let",
  "may",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "ok",
  "okay",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "they",
  "this",
  "to",
  "too",
  "us",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "yet",
  "you",
  "your",
  "yourself",
  "thanks",
  "thank",
  "yeah",
  "sure",
  "today",
  "right",
  "now",
  "very",
  "really",
  "much",
  "again",
  "tell",
  "going",
  "kind",
  "still",
  "hi",
  "hey",
  "hello",
  "there",
]);

// Vocab-valid hand-shape lookalikes used by the confusion-pair noise suite.
// Each pair is bidirectional so confusion-pair injection is symmetric.
const RAW_CONFUSION_PAIRS: readonly (readonly [string, string])[] = [
  ["MOM", "DAD"],
  ["AUNT", "UNCLE"],
  ["RED", "ORANGE"],
  ["BLUE", "GREEN"],
  ["YELLOW", "WHITE"],
  ["MAD", "SAD"],
  ["NIGHT", "MOON"],
  ["BIRD", "OWL"],
  ["DOG", "CAT"],
  ["PEN", "PENCIL"],
  ["BOOK", "READ"],
  ["HAPPY", "SMILE"],
  ["WAIT", "WAKE"],
  ["FACE", "HEAR"],
  ["HOT", "SUN"],
  ["SLEEP", "SLEEPY"],
  ["TIME", "TOMORROW"],
  ["MORNING", "AFTER"],
];

const CONFUSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  RAW_CONFUSION_PAIRS.flatMap(([a, b]) => [
    [a, b],
    [b, a],
  ]),
);

// Pool of obviously-unrelated PopSign tokens used by the extra-noise suite.
// The picker rotates through the pool so noise isn't always the same word and
// skips any token already present in the turn's signer tokens.
const NOISE_POOL: readonly string[] = [
  "ZEBRA",
  "REFRIGERATOR",
  "HELICOPTER",
  "BALLOON",
  "FLAG",
  "VACUUM",
  "PUZZLE",
  "ALLIGATOR",
  "PIZZA",
];

// Off-script synthetic turns: vocab-valid token combinations that don't match
// any combo entry. Tests whether a strategy can compose a sensible English
// reconstruction without leaning on a lookup table.
const OFF_SCRIPT_TURNS: readonly ScriptTurn[] = [
  turn(
    "off_01",
    "weather-outside",
    "Did you see the flowers in the backyard?",
    ["BLUE", "FLOWER", "PRETTY"],
    "Yes, blue and pretty flowers.",
  ),
  turn(
    "off_02",
    "food-drink",
    "Want a snack?",
    ["HUNGRY", "APPLE"],
    "I'm hungry, an apple.",
  ),
  turn(
    "off_03",
    "feelings",
    "Are you angry at someone?",
    ["MAD", "BROTHER"],
    "Mad at my brother.",
  ),
  turn(
    "off_04",
    "food-drink",
    "Pizza or not?",
    ["LIKE", "PIZZA", "NOT"],
    "I don't like pizza.",
  ),
  turn(
    "off_05",
    "family",
    "Is the baby tired?",
    ["SLEEPY", "CHILD"],
    "The child is sleepy.",
  ),
  turn(
    "off_06",
    "animals",
    "Where do you ride?",
    ["HORSE", "FARM"],
    "A horse on the farm.",
  ),
];

// Ambiguous-context synthetic turns: same tokens, different expected sentence
// depending on the hearing user's last line. Forces the model to actually use
// hearing context rather than memorize tokens-to-sentence pairs.
const AMBIGUOUS_TURNS: readonly ScriptTurn[] = [
  turn(
    "amb_01",
    "feelings",
    "Are you okay?",
    ["YES", "FINE"],
    "Yes, I'm fine.",
  ),
  turn(
    "amb_02",
    "home",
    "Is the room temperature good?",
    ["YES", "FINE"],
    "Yes, the temperature is fine.",
  ),
  turn(
    "amb_03",
    "feelings",
    "Did you have a bad day?",
    ["NO", "BAD"],
    "No, not bad.",
  ),
  turn(
    "amb_04",
    "food-drink",
    "Is the food bad?",
    ["NO", "BAD"],
    "No, the food isn't bad.",
  ),
  turn(
    "amb_05",
    "food-drink",
    "Want a drink?",
    ["LIKE", "WATER"],
    "Yes, I'd like water.",
  ),
  turn(
    "amb_06",
    "weather-outside",
    "Do you swim often?",
    ["LIKE", "WATER"],
    "I like the water.",
  ),
];

export const COMBO_ENTRIES: readonly ComboEntry[] = SCRIPT_TURNS.map(deriveCombo);

export const DEMO_DICTIONARY: Readonly<Record<string, string>> = deriveDictionary(SCRIPT_TURNS);

// Fail loudly if a token slips out of the 250-class vocabulary anywhere in the
// fixture surface. Build/dev-server requests for /prompt-tester will surface
// the offending tokens immediately rather than at LLM call time.
validateFixtureVocabulary({
  scriptTurns: [...SCRIPT_TURNS, ...OFF_SCRIPT_TURNS, ...AMBIGUOUS_TURNS],
  comboEntries: COMBO_ENTRIES,
  confusions: CONFUSIONS,
  noisePool: NOISE_POOL,
});

export const CASE_SUITES: Readonly<Record<string, readonly PromptTestCase[]>> = {
  clean: SCRIPT_TURNS.map((scriptTurn) =>
    buildCase(scriptTurn, "clean", scriptTurn.signerTokens, [scriptTurn.hearingUserSays]),
  ),

  "missing-must": SCRIPT_TURNS.map((scriptTurn) => {
    const comboEntry = getComboEntry(scriptTurn.id);
    const missing = comboEntry.must[0];
    const tokens = missing
      ? scriptTurn.signerTokens.filter((tokenValue) => tokenValue !== missing)
      : scriptTurn.signerTokens;
    return buildCase(
      scriptTurn,
      "missing-must",
      tokens,
      [scriptTurn.hearingUserSays],
      missing ? `Dropped required token ${missing}.` : "No required token to drop.",
      Boolean(missing),
    );
  }),

  "missing-opt": SCRIPT_TURNS.map((scriptTurn) => {
    const comboEntry = getComboEntry(scriptTurn.id);
    const missing = comboEntry.optional[0];
    const tokens = missing
      ? scriptTurn.signerTokens.filter((tokenValue) => tokenValue !== missing)
      : scriptTurn.signerTokens;
    return buildCase(
      scriptTurn,
      "missing-opt",
      tokens,
      [scriptTurn.hearingUserSays],
      missing
        ? `Dropped optional token ${missing}.`
        : "No optional token exists for this turn.",
    );
  }),

  "extra-noise": SCRIPT_TURNS.map((scriptTurn, index) => {
    const noise = pickNoiseToken(scriptTurn, index);
    return buildCase(
      scriptTurn,
      "extra-noise",
      [noise, ...scriptTurn.signerTokens],
      [scriptTurn.hearingUserSays],
      `Prepended unrelated vocab token ${noise}.`,
    );
  }),

  "out-of-order": SCRIPT_TURNS.map((scriptTurn) =>
    buildCase(
      scriptTurn,
      "out-of-order",
      [...scriptTurn.signerTokens].reverse(),
      [scriptTurn.hearingUserSays],
    ),
  ),

  "low-confidence": SCRIPT_TURNS.map((scriptTurn) =>
    buildCase(
      scriptTurn,
      "low-confidence",
      scriptTurn.signerTokens,
      [scriptTurn.hearingUserSays],
      "Forced token confidence to 0.42.",
      true,
      0.42,
    ),
  ),

  "no-transcript": SCRIPT_TURNS.map((scriptTurn) =>
    buildCase(scriptTurn, "no-transcript", scriptTurn.signerTokens, []),
  ),

  "confusion-pair": SCRIPT_TURNS.map((scriptTurn) => {
    const tokens = scriptTurn.signerTokens.map(
      (tokenValue) => CONFUSIONS[tokenValue] ?? tokenValue,
    );
    const changed = tokens.some(
      (tokenValue, index) => tokenValue !== scriptTurn.signerTokens[index],
    );
    return buildCase(
      scriptTurn,
      "confusion-pair",
      tokens,
      [scriptTurn.hearingUserSays],
      changed
        ? "Swapped one or more likely confusion tokens."
        : "No configured confusion applies to this turn.",
      changed,
      changed ? 0.72 : 0.9,
    );
  }),

  "cross-script": SCRIPT_TURNS.map((scriptTurn, index) => {
    const contextTurn = SCRIPT_TURNS[(index + 7) % SCRIPT_TURNS.length];
    if (!contextTurn) throw new Error("Script turns fixture is empty");
    return buildCase(
      scriptTurn,
      "cross-script",
      scriptTurn.signerTokens,
      [contextTurn.hearingUserSays],
      `Uses ${contextTurn.id} transcript with ${scriptTurn.id} tokens.`,
      true,
    );
  }),

  "off-script": OFF_SCRIPT_TURNS.map((scriptTurn) =>
    buildCase(
      scriptTurn,
      "off-script",
      scriptTurn.signerTokens,
      [scriptTurn.hearingUserSays],
      "Vocab-valid tokens that do not match any combo entry.",
      true,
    ),
  ),

  "ambiguous-context": AMBIGUOUS_TURNS.map((scriptTurn) =>
    buildCase(
      scriptTurn,
      "ambiguous-context",
      scriptTurn.signerTokens,
      [scriptTurn.hearingUserSays],
      "Same tokens, different expected sentence depending on hearing context.",
      true,
    ),
  ),
} as const;

export const CASE_SUITE_IDS = Object.keys(CASE_SUITES);
export const ALL_CASES = Object.values(CASE_SUITES).flat();

export function getCase(caseId: string): PromptTestCase {
  const testCase = ALL_CASES.find((candidate) => candidate.id === caseId);
  if (!testCase) throw new Error(`Unknown prompt test case: ${caseId}`);
  return testCase;
}

export function formatDemoDictionary(): string {
  return Object.entries(DEMO_DICTIONARY)
    .map(([tokenValue, meaning]) => `${tokenValue}=${meaning}`)
    .join("\n");
}

export function formatScriptCandidates(): string {
  return SCRIPT_TURNS.map(
    (scriptTurn) =>
      `${scriptTurn.id}: ${scriptTurn.signerTokens.join(" ")} => ${scriptTurn.reconstructedSentence}`,
  ).join("\n");
}

export function formatCombos(): string {
  const rows = COMBO_ENTRIES.map(
    (entry) =>
      `${entry.turnId}|ctx=${entry.contextHints.join(" ")}|must=${entry.must.join(",")}|opt=${entry.optional.join(",")}|say=${entry.say}`,
  );
  return ["COMBOS:", ...rows].join("\n");
}

function turn(
  id: string,
  topic: ScriptTopic,
  hearingUserSays: string,
  signerTokens: readonly string[],
  reconstructedSentence: string,
): ScriptTurn {
  return { id, topic, hearingUserSays, signerTokens, reconstructedSentence };
}

function getComboEntry(turnId: string): ComboEntry {
  const entry = COMBO_ENTRIES.find((candidate) => candidate.turnId === turnId);
  if (!entry) throw new Error(`Unknown combo entry: ${turnId}`);
  return entry;
}

// must = up to the first two non-stoplist content tokens in original order.
// optional = the rest (including stoplist tokens like YES/NO). Falls back to
// the first two raw tokens when every token is a stoplist word.
function deriveCombo(scriptTurn: ScriptTurn): ComboEntry {
  const must: string[] = [];
  const optional: string[] = [];
  for (const token of scriptTurn.signerTokens) {
    if (!HIGH_FREQ_STOPLIST.has(token) && must.length < 2) {
      must.push(token);
    } else {
      optional.push(token);
    }
  }
  if (must.length === 0 && scriptTurn.signerTokens.length > 0) {
    must.push(...scriptTurn.signerTokens.slice(0, 2));
  }
  return {
    turnId: scriptTurn.id,
    contextHints: deriveContextHints(scriptTurn.hearingUserSays),
    must,
    optional,
    say: scriptTurn.reconstructedSentence,
  };
}

function deriveContextHints(hearingUserSays: string): readonly string[] {
  const words = hearingUserSays.toLowerCase().match(/[a-z']+/g) ?? [];
  const content = words.filter((word) => !ENGLISH_STOPLIST.has(word));
  if (content.length === 0) return ["(no context)"];
  return [content.slice(0, 6).join(" ")];
}

function pickNoiseToken(scriptTurn: ScriptTurn, index: number): string {
  const used = new Set(scriptTurn.signerTokens);
  for (let offset = 0; offset < NOISE_POOL.length; offset += 1) {
    const candidate = NOISE_POOL[(index + offset) % NOISE_POOL.length];
    if (candidate && !used.has(candidate)) return candidate;
  }
  return "ZEBRA";
}

function deriveDictionary(scriptTurns: readonly ScriptTurn[]): Readonly<Record<string, string>> {
  const tokens = new Set<string>();
  for (const scriptTurn of scriptTurns) {
    for (const token of scriptTurn.signerTokens) tokens.add(token);
  }
  const sorted = [...tokens].sort();
  return Object.fromEntries(sorted.map((token) => [token, dictionaryLabel(token)]));
}

function buildCase(
  scriptTurn: ScriptTurn,
  suite: string,
  tokens: readonly string[],
  hearingTranscript: readonly string[],
  notes?: string,
  allowAlternate = false,
  confidence = 0.9,
): PromptTestCase {
  const recognizedSigns = tokensToSigns(tokens, confidence);
  const baseId = `${scriptTurn.id}/${suite}`;
  return {
    id: baseId,
    suite,
    topic: scriptTurn.topic,
    baseTurnId: scriptTurn.id,
    hearingTranscript,
    recognizedSigns,
    signTokensTopK: synthesizeTopK(recognizedSigns, baseId),
    conversationHistory: deriveConversationHistory(scriptTurn.id),
    expected: {
      sentence: scriptTurn.reconstructedSentence,
      matchedScriptId: null,
      ...(allowAlternate ? { acceptableSentences: [scriptTurn.reconstructedSentence] } : {}),
    },
    ...(notes ? { notes } : {}),
  };
}

function tokensToSigns(tokens: readonly string[], confidence: number): readonly SignToken[] {
  return tokens.map((word) => ({ word, confidence }));
}

// Walks SCRIPT_TURNS to give the case `depth` prior conversational turns. For
// synthetic turns (off_*, amb_*) that aren't in SCRIPT_TURNS, falls back to
// the first three greeting turns so the model still has plausible context.
function deriveConversationHistory(baseTurnId: string, depth = 3): readonly ConversationTurn[] {
  const idx = SCRIPT_TURNS.findIndex((scriptTurn) => scriptTurn.id === baseTurnId);
  if (idx > 0) {
    const start = Math.max(0, idx - depth);
    return SCRIPT_TURNS.slice(start, idx).map((scriptTurn) => ({
      hearing: scriptTurn.hearingUserSays,
      signer: scriptTurn.reconstructedSentence,
    }));
  }
  if (idx === 0) return [];
  return SCRIPT_TURNS.slice(0, depth).map((scriptTurn) => ({
    hearing: scriptTurn.hearingUserSays,
    signer: scriptTurn.reconstructedSentence,
  }));
}

// Synthesizes a top-3 classifier output for each recognized sign: top-1 stays
// as the captured token, the second slot is its CONFUSIONS-table lookalike if
// any, and the third slot is a deterministic distractor pulled from the noise
// pool. Scores sum to roughly 1.0 and always order top-1 > alternatives.
function synthesizeTopK(
  signs: readonly SignToken[],
  seed: string,
): readonly SignTokenTopK[] {
  return signs.map((sign, index) => {
    const seedHash = stringSeed(seed) + index;
    const confused = CONFUSIONS[sign.word];
    const distractor = pickDistractorFromPool(seedHash, sign.word);
    const altWords: string[] = [];
    if (confused && confused !== sign.word) altWords.push(confused);
    if (distractor && !altWords.includes(distractor) && distractor !== sign.word) {
      altWords.push(distractor);
    }
    const altCapacity = Math.max(0, 1 - sign.confidence);
    const altScores = [round(altCapacity * 0.7), round(altCapacity * 0.2)];
    return {
      word: sign.word,
      score: round(sign.confidence),
      alternatives: altWords.slice(0, 2).map((altWord, altIndex) => ({
        word: altWord,
        score: altScores[altIndex] ?? 0.05,
      })),
    };
  });
}

function pickDistractorFromPool(seedHash: number, exclude: string): string {
  for (let offset = 0; offset < NOISE_POOL.length; offset += 1) {
    const candidate = NOISE_POOL[(seedHash + offset) % NOISE_POOL.length];
    if (candidate && candidate !== exclude) return candidate;
  }
  return "ZEBRA";
}

function stringSeed(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
