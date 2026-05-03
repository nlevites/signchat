"use client";

import { PaperPlaneTilt } from "@phosphor-icons/react/dist/ssr";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  ParticipantInfo,
  RoomDataMessage,
} from "@signchat/contracts";
import { cn } from "@/lib/cn";
import { useTranscriptStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

export interface ChatPanelProps {
  participantInfo: ParticipantInfo;
  publish: (msg: RoomDataMessage) => Promise<void>;
}

export function ChatPanel({ participantInfo, publish }: ChatPanelProps) {
  const messages = useTranscriptStore((s) => s.messages);
  const chatMessages = useMemo(
    () => messages.filter((m): m is ChatMessage => m.kind === "chat"),
    [messages],
  );

  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // pin to the bottom whenever the chat list grows. scrollTop is set
  // imperatively rather than via scrollIntoView so an offscreen aside
  // doesn't yank the page.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages.length]);

  const trySend = async () => {
    if (submitting) return;
    const text = draft.trim();
    if (!text) return;
    const msg: ChatMessage = {
      v: 1,
      kind: "chat",
      id: crypto.randomUUID(),
      ts: Date.now(),
      from: participantInfo,
      text,
    };
    setSubmitting(true);
    try {
      await publish(msg);
      // livekit broadcasts to others only — append locally so the sender
      // sees their own message immediately.
      useTranscriptStore.getState().appendMessage(msg);
      setDraft("");
      inputRef.current?.focus();
    } catch (err) {
      console.error("[chat] publish failed", err);
      toast.error("Could not send message.");
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void trySend();
    }
  };

  const canSend = draft.trim().length > 0 && !submitting;

  return (
    <div className="flex h-full flex-col bg-sc-surface">
      <header className="flex shrink-0 items-center justify-between border-b border-sc-divider px-4 py-3">
        <span className="t-meta uppercase text-sc-text-3">Chat</span>
        <span className="t-meta font-mono text-sc-text-3">
          {chatMessages.length}
        </span>
      </header>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto px-3 py-3"
        aria-live="polite"
      >
        {chatMessages.length === 0 ? (
          <p className="t-body-sm text-sc-text-3">
            No messages yet. Say hello.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {chatMessages.map((msg) => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                isOwn={msg.from.identity === participantInfo.identity}
              />
            ))}
          </ul>
        )}
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-t border-sc-divider p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void trySend();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={submitting}
          placeholder="Type a message…"
          aria-label="Chat message"
          maxLength={2000}
          className="h-10 flex-1 rounded-sc-md border border-sc-border bg-sc-surface px-3 t-body-sm text-sc-text placeholder:text-sc-text-3 focus:border-sc-border-strong disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          title="Send"
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-sc-full transition-[background-color,filter,transform] duration-200",
            canSend
              ? "sc-luminous hover:-translate-y-px hover:brightness-105 active:translate-y-0"
              : "bg-sc-surface-2 text-sc-text-3",
          )}
        >
          <PaperPlaneTilt size={16} weight="fill" />
        </button>
      </form>
    </div>
  );
}

interface ChatBubbleProps {
  msg: ChatMessage;
  isOwn: boolean;
}

function ChatBubble({ msg, isOwn }: ChatBubbleProps) {
  return (
    <li
      className={cn(
        "flex flex-col gap-1",
        isOwn ? "items-end" : "items-start",
      )}
    >
      <div
        className={cn(
          "flex items-baseline gap-2 px-1 t-meta",
          isOwn ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className="font-medium text-sc-text-2">
          {isOwn ? "You" : msg.from.name}
        </span>
        <span className="font-mono text-sc-text-3">{formatTime(msg.ts)}</span>
      </div>
      <div
        className={cn(
          "max-w-[85%] rounded-sc-lg px-3 py-2 t-body-sm break-words whitespace-pre-wrap",
          isOwn
            ? "rounded-tr-sm bg-sc-accent-500 text-white"
            : "rounded-tl-sm bg-sc-surface-2 text-sc-text",
        )}
      >
        {msg.text}
      </div>
    </li>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
