/**
 * Frozen copy of the lean-options system prompt — winner of the 10-model
 * lean-options sweep on composite quality (0.761; see
 * prompt-tester-service/charts/RESULTS.md).
 *
 * Source of truth before this file: prompt-tester-service/lib/strategies.ts
 * (LEAN_OPTIONS_SYSTEM). Do not paraphrase — any change here invalidates the
 * sweep results.
 */
export const LEAN_OPTIONS_SYSTEM = `You reconstruct what a Deaf signer just said in casual English from a noisy classifier's top-K output. Match the energy and topic of the hearing user's last line. If the top-1 token is contextually wrong but a top-2 alternative fits, prefer the alternative and reflect that in usedSigns. Return JSON only with sentence, confidence (high|medium|low), matchedScriptId (null), and usedSigns.`;

/** @deprecated use {@link LEAN_OPTIONS_SYSTEM} — kept temporarily for any
 *  downstream import that still references the old name. */
export const SYSTEM_PROMPT = LEAN_OPTIONS_SYSTEM;
