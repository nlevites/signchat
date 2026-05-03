"use client";

import { ArrowLeft, HandWaving, SpeakerHigh } from "@phosphor-icons/react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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

const rail = "h-px w-full shrink-0 bg-[#e3e3e2]";

export function StartForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialRoom = (searchParams.get("room") ?? "").trim();
  const nameRef = useRef<HTMLInputElement>(null);
  const deafRoleRef = useRef<HTMLButtonElement>(null);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role | null>(null);
  const [roomCode, setRoomCode] = useState(initialRoom);

  // If the user arrives via a shared room link (`/start?room=…`),
  // prompt them to fill in the missing pieces rather than create a new room.
  useEffect(() => {
    if (initialRoom.length > 0) nameRef.current?.focus();
  }, [initialRoom]);
  const [submitting, setSubmitting] = useState(false);
  const [nameHint, setNameHint] = useState(false);
  const [roleHint, setRoleHint] = useState(false);

  const trimmedName = name.trim();
  const trimmedCode = roomCode.trim();
  const canJoin =
    trimmedName.length > 0 && role !== null && trimmedCode.length > 0;

  const go = (room: string) => {
    if (!role) return;
    setSubmitting(true);
    const params = new URLSearchParams({ name: trimmedName, role });
    router.push(`/room/${encodeURIComponent(room)}?${params.toString()}`);
  };

  function handleCreateRoom() {
    if (submitting) return;
    const needsName = trimmedName.length === 0;
    const needsRole = role === null;
    setNameHint(needsName);
    setRoleHint(needsRole);
    if (needsName) {
      nameRef.current?.focus();
      return;
    }
    if (needsRole) {
      deafRoleRef.current?.focus();
      return;
    }
    go(newRoomId());
  }

  function handleJoin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (canJoin) go(trimmedCode);
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={handleJoin}
    >
      <label className="flex flex-col gap-2 pb-6">
        <span className="t-label text-sc-text">Display name</span>
        <input
          ref={nameRef}
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameHint(false);
          }}
          placeholder="e.g. Alex"
          maxLength={32}
          aria-invalid={nameHint}
          aria-describedby={nameHint ? "start-name-hint" : undefined}
          className={cn(
            inputBase,
            nameHint &&
              "border-sc-danger hover:border-sc-danger focus-visible:border-sc-danger focus-visible:shadow-[0_0_0_4px_rgba(219,79,59,0.14)]",
          )}
        />
        {nameHint ? (
          <p id="start-name-hint" className="t-meta text-sc-danger" role="alert">
            Enter a display name to create a room.
          </p>
        ) : null}
      </label>

      <div className={rail} aria-hidden />

      <fieldset
        className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0 py-6"
        aria-describedby={roleHint ? "start-role-hint" : undefined}
      >
        <legend className="mb-2 block w-full px-0 t-label text-sc-text">
          Role
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <RoleCard
            ref={deafRoleRef}
            icon={<HandWaving size={24} weight="regular" />}
            label="Deaf signer"
            description="Sign on camera; your signs are reconstructed and spoken."
            checked={role === "deaf"}
            onSelect={() => {
              setRole("deaf");
              setRoleHint(false);
            }}
          />
          <RoleCard
            icon={<SpeakerHigh size={24} weight="regular" />}
            label="Hearing peer"
            description="Talk normally; your voice becomes captions on their tile."
            checked={role === "hearing"}
            onSelect={() => {
              setRole("hearing");
              setRoleHint(false);
            }}
          />
        </div>
        {roleHint ? (
          <p id="start-role-hint" className="t-meta text-sc-danger" role="alert">
            Choose whether you are signing or joining by voice.
          </p>
        ) : null}
      </fieldset>

      <div className={rail} aria-hidden />

      {initialRoom.length > 0 ? (
        /* shared-link path: room id is known, no create flow makes sense.
         * fill name + role and the form's onSubmit goes to /room/<id>. */
        <div className="flex flex-1 flex-col gap-3 pt-6">
          <p className="t-meta text-sc-text-2">
            Joining room{" "}
            <code className="font-mono text-sc-text">{initialRoom}</code>
          </p>
          <button
            type="submit"
            disabled={!canJoin || submitting}
            className="sc-luminous inline-flex h-12 w-full items-center justify-center rounded-sc-full px-6 text-[15px] font-medium transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:opacity-40 disabled:pointer-events-none"
          >
            Join room
          </button>
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-3 pt-6">
          <button
            type="button"
            disabled={submitting}
            onClick={handleCreateRoom}
            className="sc-luminous inline-flex h-12 w-full items-center justify-center rounded-sc-full px-6 text-[15px] font-medium transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:opacity-40 disabled:pointer-events-none"
          >
            Create new room
          </button>

          <div className="my-1 flex items-center gap-3 text-sc-text-3">
            <span className="h-px min-w-0 flex-1 bg-[#e3e3e2]" />
            <span className="t-meta uppercase">or join existing</span>
            <span className="h-px min-w-0 flex-1 bg-[#e3e3e2]" />
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
              className="sc-btn-secondary inline-flex h-10 items-center justify-center rounded-sc-full px-5 t-label hover:-translate-y-px disabled:opacity-40 disabled:pointer-events-none"
            >
              Join
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => router.push("/")}
        className="mt-auto inline-flex items-center justify-center gap-2 self-center rounded-sc-md px-3 pb-1 pt-8 t-label text-sc-text-3 transition-colors duration-150 hover:text-sc-text-2"
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

const RoleCard = forwardRef<HTMLButtonElement, RoleCardProps>(
  function RoleCard({ icon, label, description, checked, onSelect }, ref) {
    return (
      <button
        ref={ref}
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
  },
);
RoleCard.displayName = "RoleCard";
