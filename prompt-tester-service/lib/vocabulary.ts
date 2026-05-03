// PopSign v1.0 / Kaggle Google Isolated Sign Language Recognition vocabulary.
// Mirror of public/models/asl-signs/sign_to_prediction_index_map.json with
// labels uppercased so fixture tokens read consistently. Hardcoded as a set
// so this module can be imported from both server and client code without
// touching the filesystem.

export const VOCABULARY_LABELS: ReadonlySet<string> = new Set([
  "TV",
  "AFTER",
  "AIRPLANE",
  "ALL",
  "ALLIGATOR",
  "ANIMAL",
  "ANOTHER",
  "ANY",
  "APPLE",
  "ARM",
  "AUNT",
  "AWAKE",
  "BACKYARD",
  "BAD",
  "BALLOON",
  "BATH",
  "BECAUSE",
  "BED",
  "BEDROOM",
  "BEE",
  "BEFORE",
  "BESIDE",
  "BETTER",
  "BIRD",
  "BLACK",
  "BLOW",
  "BLUE",
  "BOAT",
  "BOOK",
  "BOY",
  "BROTHER",
  "BROWN",
  "BUG",
  "BYE",
  "CALLONPHONE",
  "CAN",
  "CAR",
  "CARROT",
  "CAT",
  "CEREAL",
  "CHAIR",
  "CHEEK",
  "CHILD",
  "CHIN",
  "CHOCOLATE",
  "CLEAN",
  "CLOSE",
  "CLOSET",
  "CLOUD",
  "CLOWN",
  "COW",
  "COWBOY",
  "CRY",
  "CUT",
  "CUTE",
  "DAD",
  "DANCE",
  "DIRTY",
  "DOG",
  "DOLL",
  "DONKEY",
  "DOWN",
  "DRAWER",
  "DRINK",
  "DROP",
  "DRY",
  "DRYER",
  "DUCK",
  "EAR",
  "ELEPHANT",
  "EMPTY",
  "EVERY",
  "EYE",
  "FACE",
  "FALL",
  "FARM",
  "FAST",
  "FEET",
  "FIND",
  "FINE",
  "FINGER",
  "FINISH",
  "FIREMAN",
  "FIRST",
  "FISH",
  "FLAG",
  "FLOWER",
  "FOOD",
  "FOR",
  "FRENCHFRIES",
  "FROG",
  "GARBAGE",
  "GIFT",
  "GIRAFFE",
  "GIRL",
  "GIVE",
  "GLASSWINDOW",
  "GO",
  "GOOSE",
  "GRANDMA",
  "GRANDPA",
  "GRASS",
  "GREEN",
  "GUM",
  "HAIR",
  "HAPPY",
  "HAT",
  "HATE",
  "HAVE",
  "HAVETO",
  "HEAD",
  "HEAR",
  "HELICOPTER",
  "HELLO",
  "HEN",
  "HESHEIT",
  "HIDE",
  "HIGH",
  "HOME",
  "HORSE",
  "HOT",
  "HUNGRY",
  "ICECREAM",
  "IF",
  "INTO",
  "JACKET",
  "JEANS",
  "JUMP",
  "KISS",
  "KITTY",
  "LAMP",
  "LATER",
  "LIKE",
  "LION",
  "LIPS",
  "LISTEN",
  "LOOK",
  "LOUD",
  "MAD",
  "MAKE",
  "MAN",
  "MANY",
  "MILK",
  "MINEMY",
  "MITTEN",
  "MOM",
  "MOON",
  "MORNING",
  "MOUSE",
  "MOUTH",
  "NAP",
  "NAPKIN",
  "NIGHT",
  "NO",
  "NOISY",
  "NOSE",
  "NOT",
  "NOW",
  "NUTS",
  "OLD",
  "ON",
  "OPEN",
  "ORANGE",
  "OUTSIDE",
  "OWIE",
  "OWL",
  "PAJAMAS",
  "PEN",
  "PENCIL",
  "PENNY",
  "PERSON",
  "PIG",
  "PIZZA",
  "PLEASE",
  "POLICE",
  "POOL",
  "POTTY",
  "PRETEND",
  "PRETTY",
  "PUPPY",
  "PUZZLE",
  "QUIET",
  "RADIO",
  "RAIN",
  "READ",
  "RED",
  "REFRIGERATOR",
  "RIDE",
  "ROOM",
  "SAD",
  "SAME",
  "SAY",
  "SCISSORS",
  "SEE",
  "SHHH",
  "SHIRT",
  "SHOE",
  "SHOWER",
  "SICK",
  "SLEEP",
  "SLEEPY",
  "SMILE",
  "SNACK",
  "SNOW",
  "STAIRS",
  "STAY",
  "STICKY",
  "STORE",
  "STORY",
  "STUCK",
  "SUN",
  "TABLE",
  "TALK",
  "TASTE",
  "THANKYOU",
  "THAT",
  "THERE",
  "THINK",
  "THIRSTY",
  "TIGER",
  "TIME",
  "TOMORROW",
  "TONGUE",
  "TOOTH",
  "TOOTHBRUSH",
  "TOUCH",
  "TOY",
  "TREE",
  "UNCLE",
  "UNDERWEAR",
  "UP",
  "VACUUM",
  "WAIT",
  "WAKE",
  "WATER",
  "WET",
  "WEUS",
  "WHERE",
  "WHITE",
  "WHO",
  "WHY",
  "WILL",
  "WOLF",
  "YELLOW",
  "YES",
  "YESTERDAY",
  "YOURSELF",
  "YUCKY",
  "ZEBRA",
  "ZIPPER",
]);

// Compound class labels need a human reading; everything else falls back to
// its lowercase form. Used by the auto-derived demo dictionary so the LLM
// sees `WEUS=we/us` rather than the raw classifier label.
export const DICTIONARY_LABELS: Readonly<Record<string, string>> = {
  WEUS: "we/us",
  HESHEIT: "he/she/it",
  MINEMY: "my/mine",
  HAVETO: "have to",
  CALLONPHONE: "call on phone",
  FRENCHFRIES: "french fries",
  GLASSWINDOW: "window",
  ICECREAM: "ice cream",
  TV: "TV",
  THANKYOU: "thank you",
  SHHH: "shush",
  OWIE: "owie",
  YUCKY: "yucky",
};

export function dictionaryLabel(token: string): string {
  return DICTIONARY_LABELS[token] ?? token.toLowerCase();
}

export function isVocabToken(token: string): boolean {
  return VOCABULARY_LABELS.has(token);
}

export function assertVocabToken(token: string): void {
  if (!VOCABULARY_LABELS.has(token)) {
    throw new Error(
      `Token "${token}" is not in the 250-class PopSign vocabulary. ` +
        `Add a real PopSign label or remove this token from the fixture.`,
    );
  }
}

export function validateVocabulary(tokens: Iterable<string>): void {
  const offenders = new Set<string>();
  for (const token of tokens) {
    if (!VOCABULARY_LABELS.has(token)) offenders.add(token);
  }
  if (offenders.size > 0) {
    throw new Error(
      `Out-of-vocabulary tokens (must be one of the 250 PopSign labels): ` +
        [...offenders].sort().join(", "),
    );
  }
}

export interface FixtureSources {
  scriptTurns: readonly { signerTokens: readonly string[] }[];
  comboEntries: readonly { must: readonly string[]; optional: readonly string[] }[];
  confusions: Readonly<Record<string, string>>;
  noisePool: readonly string[];
}

export function validateFixtureVocabulary(input: FixtureSources): void {
  const tokens = new Set<string>();
  for (const turn of input.scriptTurns) {
    for (const token of turn.signerTokens) tokens.add(token);
  }
  for (const combo of input.comboEntries) {
    for (const token of combo.must) tokens.add(token);
    for (const token of combo.optional) tokens.add(token);
  }
  for (const [from, to] of Object.entries(input.confusions)) {
    tokens.add(from);
    tokens.add(to);
  }
  for (const token of input.noisePool) tokens.add(token);
  validateVocabulary(tokens);
}
