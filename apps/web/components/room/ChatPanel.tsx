"use client";

interface ChatPanelProps {
  identity: string | null;
}

export function ChatPanel({ identity }: ChatPanelProps) {
  return (
    <div className="flex h-full flex-col bg-sc-surface">
      <header className="flex items-center justify-between border-b border-sc-divider px-4 py-3">
        <span className="t-meta uppercase text-sc-text-3">Chat</span>
        <span className="t-meta font-mono text-sc-text-3">0</span>
      </header>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <p className="t-body-sm text-sc-text-3">
          No messages yet. The chat composer lands when LiveKit data channels
          are wired up.
        </p>
      </div>
      <div className="border-t border-sc-divider p-3">
        <input
          disabled
          placeholder={identity ? "Type a message…" : "Joining…"}
          className="h-10 w-full rounded-sc-md border border-sc-border bg-sc-surface px-3 t-body-sm text-sc-text placeholder:text-sc-text-3 disabled:opacity-60"
        />
      </div>
    </div>
  );
}
