/**
 * Frozen copy of the `lean-options` strategy from prompt-tester-service. This
 * strategy won the 10-model lean-options sweep on composite quality (0.761;
 * see prompt-tester-service/charts/RESULTS.md) and is the prompt the
 * production /room/[id] reconstruction path will ship with.
 *
 * Source of truth before this file: prompt-tester-service/lib/strategies.ts
 * and prompt-tester-service/lib/vocabulary.ts. This file is the single point
 * of contact for the workbench so the OpenRouter pane has no runtime dep on
 * the prompt-tester service.
 *
 * Why a 13-entry dictionary instead of the 66-entry DEMO_DICTIONARY?
 * DEMO_DICTIONARY in fixtures.ts is a precomputed snapshot of
 * dictionaryLabel(token) over the 66 tokens that happen to appear in the 43
 * SCRIPT_TURNS used by the prompt-tester sweep. The live workbench classifier
 * can return any of the 250 PopSign labels, so we keep only the compound-
 * label overrides and let dictionaryLabel(token) fall back to
 * token.toLowerCase() for everything else. That covers all 250 classes
 * correctly without bloating the prompt.
 */

export interface SignTokenAlternative {
  word: string;
  score: number;
}

export interface SignTokenTopK {
  word: string;
  score: number;
  alternatives: readonly SignTokenAlternative[];
}

// === Frozen lean-options templates ==========================================

export const LEAN_OPTIONS_SYSTEM = `You reconstruct what a Deaf signer just said in casual English from a noisy classifier's top-K output. Match the energy and topic of the hearing user's last line. If the top-1 token is contextually wrong but a top-2 alternative fits, prefer the alternative and reflect that in usedSigns. Return JSON only with sentence, confidence (high|medium|low), matchedScriptId (null), and usedSigns.`;

export const LEAN_OPTIONS_USER = `Hearing said: {{hearingTranscript}}
Top-K classifier output for the current sign turn:
{{signTokensTopK}}
Word translations: {{recognizedSignsTopKDictionary}}

Return JSON only.`;

// === Vocabulary translations ================================================
// Verbatim copy of DICTIONARY_LABELS from prompt-tester-service/lib/vocabulary.ts.
// Compound class labels need a human reading; everything else falls back to
// its lowercase form via dictionaryLabel().

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

// === User-prompt composition ================================================

export interface ComposeUserPromptArgs {
  /** The hearing user's most recent transcript line. Empty string is fine. */
  hearingTranscript: string;
  /**
   * Per-frame top-K classifier output for this turn. Order matters — it's the
   * temporal order the signer produced the signs in.
   */
  topK: ReadonlyArray<SignTokenTopK>;
}

/**
 * Fill the three placeholders that the lean-options user template uses
 * ({{hearingTranscript}}, {{signTokensTopK}}, {{recognizedSignsTopKDictionary}})
 * and return the composed user prompt as a string.
 */
export function composeUserPrompt(args: ComposeUserPromptArgs): string {
  const hearing =
    args.hearingTranscript.trim().length > 0 ? args.hearingTranscript : "(none)";
  const topKBlock = JSON.stringify(args.topK, null, 2);
  const dictBlock = formatRecognizedSignsTopKDictionary(args.topK);
  return LEAN_OPTIONS_USER.replaceAll("{{hearingTranscript}}", hearing)
    .replaceAll("{{signTokensTopK}}", topKBlock)
    .replaceAll("{{recognizedSignsTopKDictionary}}", dictBlock);
}

/**
 * Translation lines for every distinct token referenced by this turn's top-K
 * (top-1 plus all alternatives), one per line, alphabetized for stable output.
 * Stays small because only this turn's words appear, not the full 250.
 */
export function formatRecognizedSignsTopKDictionary(
  topK: ReadonlyArray<SignTokenTopK>,
): string {
  const tokens = new Set<string>();
  for (const slot of topK) {
    tokens.add(slot.word);
    for (const alt of slot.alternatives) tokens.add(alt.word);
  }
  return [...tokens]
    .sort()
    .map((t) => `${t}=${dictionaryLabel(t)}`)
    .join("\n");
}
