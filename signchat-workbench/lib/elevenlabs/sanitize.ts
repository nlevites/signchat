/**
 * Sanitize a sentence before sending to the ElevenLabs streaming TTS WSS.
 *
 * Per ARCHITECTURE.md §5.9 the LLM system prompt soft-guards against the
 * model emitting parenthetical stage directions, square-bracketed tags,
 * asterisk markdown, or emoji — but the browser-side strip is the
 * load-bearing one. The model occasionally emits any of these even when
 * told not to, and any of them ends up read aloud verbatim by the TTS
 * voice ("open paren laughs close paren") if they reach the synth.
 *
 * Pure function, no deps. Same behaviour expected on Node and browser.
 */

const PARENS_RE = /\([^()]*\)/g;
const BRACKETS_RE = /\[[^\[\]]*\]/g;
const ASTERISK_EMPHASIS_RE = /\*+([^*\n]+?)\*+/g;
// Drop emoji + variation selectors. The Extended_Pictographic property
// covers the modern emoji set; FE0F is the variation selector that
// disambiguates text vs emoji presentation; ZWJ ties multi-codepoint
// emoji together. Stripping these leaves prose intact while removing
// the entire pictographic surface.
const EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const WHITESPACE_RE = /\s+/g;

export function sanitizeForTts(text: string): string {
  if (!text) return "";
  let out = text;
  // Run parens/brackets twice in case of nested groups: `(hello (world))`
  // collapses to "" only after two passes.
  for (let i = 0; i < 2; i++) {
    out = out.replace(PARENS_RE, "").replace(BRACKETS_RE, "");
  }
  out = out.replace(ASTERISK_EMPHASIS_RE, "$1");
  out = out.replace(EMOJI_RE, "");
  out = out.replace(WHITESPACE_RE, " ").trim();
  return out;
}

/**
 * Tokenized diff for the Phase 4 pane's "live sanitize preview". Returns
 * the kept and stripped slices in order, useful for highlighting what
 * was removed without recomputing the regex on the UI side.
 */
export interface SanitizeBreakdown {
  cleaned: string;
  /** True when sanitization removed at least one character. */
  changed: boolean;
}

export function sanitizeWithDiff(text: string): SanitizeBreakdown {
  const cleaned = sanitizeForTts(text);
  return { cleaned, changed: cleaned !== text.trim().replace(WHITESPACE_RE, " ") };
}
