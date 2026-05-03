"use client";

import { ArrowLeft, HandWaving, SpeakerHigh } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { Role } from "@signchat/contracts";
import { cn } from "@/lib/cn";

const ROOM_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newRoomId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return out;
}

const inputBase =
  "h-10 w-full rounded-sc-md border border-sc-border bg-sc-surface px-3 t-body-sm text-sc-text placeholder:text-sc-text-3 transition-[border-color,box-shadow] duration-200 hover:border-sc-border-strong focus-visible:outline-none focus-visible:border-sc-accent-500 focus-visible:shadow-[var(--sc-glow-sm)]";

export function StartForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const trimmedName = name.trim();
  const trimmedCode = roomCode.trim();
  const canCreate = trimmedName.length > 0 && role !== null;
  const canJoin = canCreate && trimmedCode.length > 0;

  const go = (room: string) => {
    if (!role) return;
    setSubmitting(true);
    const params = new URLSearchParams({ name: trimmedName, role });
    router.push(`/room/${encodeURIComponent(room)}?${params.toString()}`);
  };

  function handleJoin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (canJoin) go(trimmedCode);
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={handleJoin}>
      <label className="flex flex-col gap-2">
        <span className="t-label text-sc-text">Display name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Alex"
          maxLength={32}
          className={inputBase}
        />
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="t-label text-sc-text">Role</legend>
        <div className="grid grid-cols-2 gap-3">
          <RoleCard
            icon={<HandWaving size={24} weight="regular" />}
            label="Deaf signer"
            description="Sign on camera; your signs are reconstructed and spoken."
            checked={role === "deaf"}
            onSelect={() => setRole("deaf")}
          />
          <RoleCard
            icon={<SpeakerHigh size={24} weight="regular" />}
            label="Hearing peer"
            description="Talk normally; your voice becomes captions on their tile."
            checked={role === "hearing"}
            onSelect={() => setRole("hearing")}
          />
        </div>
      </fieldset>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          disabled={!canCreate || submitting}
          onClick={() => go(newRoomId())}
          className="sc-luminous inline-flex h-12 w-full items-center justify-center rounded-sc-full px-6 text-[15px] font-medium transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:opacity-40 disabled:pointer-events-none"
        >
          Create new room
        </button>

        <div className="my-1 flex items-center gap-3 text-sc-text-3">
          <span className="h-px flex-1 bg-sc-divider" />
          <span className="t-meta uppercase">or join existing</span>
          <span className="h-px flex-1 bg-sc-divider" />
        </div>

        <div className="flex gap-2">
          <input
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            placeholder="room code"
            maxLength={32}
            className={cn(inputBase, "flex-1")}
          />
          <button
            type="submit"
            disabled={!canJoin || submitting}
            className="inline-flex h-10 items-center justify-center rounded-sc-full border border-sc-border bg-sc-surface px-5 t-label text-sc-text transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-sc-border-strong hover:shadow-sc-sm disabled:opacity-40 disabled:pointer-events-none"
          >
            Join
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => router.push("/")}
        className="mt-2 inline-flex items-center justify-center gap-2 self-center rounded-sc-md px-3 py-2 t-label text-sc-text-3 transition-colors duration-150 hover:text-sc-text-2"
      >
        <ArrowLeft size={14} weight="bold" />
        Back
      </button>
    </form>
  );
}

interface RoleCardProps {
  icon: ReactNode;
  label: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}

function RoleCard({ icon, label, description, checked, onSelect }: RoleCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={cn(
        "flex flex-col items-start gap-2 rounded-sc-lg border p-4 text-left transition-[border-color,background-color,box-shadow] duration-200",
        checked
          ? "border-sc-accent-500 bg-sc-accent-soft shadow-[var(--sc-glow-sm)]"
          : "border-sc-border bg-sc-surface hover:border-sc-border-strong",
      )}
    >
      <span className={checked ? "text-sc-accent-700" : "text-sc-text-3"}>
        {icon}
      </span>
      <span className="t-h3 text-sc-text">{label}</span>
      <span className="t-body-sm text-sc-text-2">{description}</span>
    </button>
  );
}
