export interface SignToken {
  label: string;
  score: number;
  ts: number;
  via: "stable" | "band";
}

export interface SignBuffer {
  tokens: SignToken[];
  startedAt: number;
  lastAdmitAt: number | null;
  epoch: number;
}
