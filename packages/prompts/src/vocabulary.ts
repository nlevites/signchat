/**
 * Compound-label overrides for PopSign tokens that don't read naturally as
 * lowercase words. Verbatim copy of DICTIONARY_LABELS from
 * prompt-tester-service/lib/vocabulary.ts (and the workbench frozen copy in
 * signchat-workbench/lib/openrouter/prompt.ts).
 *
 * Tokens not present here fall back to `token.toLowerCase()` via
 * {@link dictionaryLabel}. That covers all 250 PopSign classes correctly
 * without inflating the user prompt.
 */
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
