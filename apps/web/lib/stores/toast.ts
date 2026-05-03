import { create } from "zustand";

export type ToastKind = "info" | "warn" | "error" | "success";

export interface ToastMessage {
  id: string;
  kind: ToastKind;
  text: string;
}

interface ToastState {
  messages: ToastMessage[];
  push: (msg: Omit<ToastMessage, "id">) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  messages: [],
  push: ({ kind, text }) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({ messages: [...s.messages, { id, kind, text }] }));
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
}));

function pushToast(kind: ToastKind, text: string): string {
  return useToastStore.getState().push({ kind, text });
}

export const toast = {
  info: (text: string) => pushToast("info", text),
  warn: (text: string) => pushToast("warn", text),
  error: (text: string) => pushToast("error", text),
  success: (text: string) => pushToast("success", text),
};
