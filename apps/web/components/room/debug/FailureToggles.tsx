"use client";

import { useDebugFlagsStore } from "@/lib/stores";
import { cn } from "@/lib/cn";

interface FailureToggle {
  id: "force_llm_error" | "force_tts_error" | "force_session_budget";
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

export interface FailureTogglesProps {
  className?: string;
}

export function FailureToggles({ className }: FailureTogglesProps) {
  const forceLLMError = useDebugFlagsStore((s) => s.forceLLMError);
  const forceTTSError = useDebugFlagsStore((s) => s.forceTTSError);
  const forceSessionBudget = useDebugFlagsStore((s) => s.forceSessionBudget);
  const setForceLLMError = useDebugFlagsStore((s) => s.setForceLLMError);
  const setForceTTSError = useDebugFlagsStore((s) => s.setForceTTSError);
  const setForceSessionBudget = useDebugFlagsStore(
    (s) => s.setForceSessionBudget,
  );

  const toggles: ReadonlyArray<FailureToggle> = [
    {
      id: "force_llm_error",
      hint: "Skip OpenRouter; controller drops buffer, returns to idle.",
      checked: forceLLMError,
      onChange: setForceLLMError,
    },
    {
      id: "force_tts_error",
      hint: "Skip ElevenLabs; controller surfaces tts_unavailable. No caption broadcast.",
      checked: forceTTSError,
      onChange: setForceTTSError,
    },
    {
      id: "force_session_budget",
      hint: "Surfaces 429 quota_exhausted toast; controller locks until reload.",
      checked: forceSessionBudget,
      onChange: setForceSessionBudget,
    },
  ];

  return (
    <div
      className={cn(
        "rounded-sc-lg border border-sc-border bg-sc-surface p-4",
        className,
      )}
    >
      <h3 className="t-h3 mb-3 text-sc-text">Failure-mode injection</h3>
      <div className="flex flex-col gap-3">
        {toggles.map((t) => (
          <ToggleRow
            key={t.id}
            label={t.id}
            hint={t.hint}
            checked={t.checked}
            onChange={t.onChange}
          />
        ))}
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function ToggleRow({ label, hint, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-sc-accent-500"
      />
      <div className="flex flex-col gap-1">
        <code className="rounded-sc-xs bg-sc-surface-2 px-1.5 py-0.5 font-mono text-[12px] text-sc-text">
          {label}
        </code>
        <p className="t-body-sm text-sc-text-2">{hint}</p>
      </div>
    </label>
  );
}
