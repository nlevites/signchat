export type ReconstructionPayload = {
  sentence: string;
  confidence: "high" | "medium" | "low";
  matchedScriptId: string | null;
  usedSigns: string[];
  needsClarification: boolean;
};
