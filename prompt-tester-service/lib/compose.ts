import type { PromptTestCase } from "./types";
import {
  DEMO_DICTIONARY,
  formatCombos,
  formatDemoDictionary,
  formatScriptCandidates,
} from "./fixtures";

const HIGH_FREQ_TOKENS: readonly string[] = [
  "YES",
  "NO",
  "PLEASE",
  "THANKYOU",
  "FINE",
  "SAME",
  "TIME",
];

export function composeUserPrompt(template: string, testCase: PromptTestCase): string {
  const replacements: Readonly<Record<string, string>> = {
    recognizedSigns: JSON.stringify(testCase.recognizedSigns, null, 2),
    hearingTranscript:
      testCase.hearingTranscript.length > 0 ? testCase.hearingTranscript.join("\n") : "(none)",
    dictionary: formatDemoDictionary(),
    scriptCandidates: formatScriptCandidates(),
    combos: formatCombos(),
    signTokensTopK: formatTopK(testCase),
    conversationHistory: formatConversationHistory(testCase),
    narrowedDictionary: formatNarrowedDictionary(testCase),
    recognizedSignsTopKDictionary: formatRecognizedSignsTopKDictionary(testCase),
  };

  let composed = template;
  for (const [name, value] of Object.entries(replacements)) {
    composed = composed.replaceAll(`{{${name}}}`, value);
  }
  return composed;
}

function formatTopK(testCase: PromptTestCase): string {
  if (!testCase.signTokensTopK || testCase.signTokensTopK.length === 0) {
    return JSON.stringify(testCase.recognizedSigns, null, 2);
  }
  return JSON.stringify(testCase.signTokensTopK, null, 2);
}

function formatConversationHistory(testCase: PromptTestCase): string {
  const history = testCase.conversationHistory ?? [];
  if (history.length === 0) return "(beginning of conversation)";
  return history
    .map(
      (turn, index) =>
        `[${index + 1}] Hearing: ${turn.hearing}\n    Signer: ${turn.signer}`,
    )
    .join("\n");
}

// For lean-fast: include the high-frequency tokens (YES/NO/PLEASE/...) plus
// any dictionary entry whose meaning shares a content word with the most
// recent hearing line. Keeps the prompt small while still giving the model
// the lexical handles it actually needs for this turn.
function formatNarrowedDictionary(testCase: PromptTestCase): string {
  const hearing = testCase.hearingTranscript.join(" ").toLowerCase();
  const selected = new Set<string>(HIGH_FREQ_TOKENS);
  for (const [token, meaning] of Object.entries(DEMO_DICTIONARY)) {
    if (selected.has(token)) continue;
    const meaningWords = meaning.toLowerCase().split(/[\/\s]+/);
    if (meaningWords.some((word) => word.length > 1 && hearing.includes(word))) {
      selected.add(token);
    }
  }
  for (const sign of testCase.recognizedSigns) {
    if (DEMO_DICTIONARY[sign.word]) selected.add(sign.word);
  }
  return [...selected]
    .sort()
    .map((token) => `${token}=${DEMO_DICTIONARY[token] ?? token.toLowerCase()}`)
    .join("\n");
}

// For lean-options: dictionary entries only for the words that actually
// appear in this turn's top-K block (top-1 plus alternatives). Falls back
// to the recognizedSigns words when the case has no top-K data so the
// placeholder always resolves to something useful.
function formatRecognizedSignsTopKDictionary(testCase: PromptTestCase): string {
  const tokens = new Set<string>();
  if (testCase.signTokensTopK && testCase.signTokensTopK.length > 0) {
    for (const slot of testCase.signTokensTopK) {
      tokens.add(slot.word);
      for (const alternative of slot.alternatives) tokens.add(alternative.word);
    }
  } else {
    for (const sign of testCase.recognizedSigns) tokens.add(sign.word);
  }
  return [...tokens]
    .sort()
    .map((token) => `${token}=${DEMO_DICTIONARY[token] ?? token.toLowerCase()}`)
    .join("\n");
}
