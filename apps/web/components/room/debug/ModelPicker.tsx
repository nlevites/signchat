"use client";

import { Select, type SelectOption } from "@/components/ui/Select";
import { cn } from "@/lib/cn";

export interface ModelPickerOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface ModelPickerProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<ModelPickerOption<T>>;
  onChange: (next: T) => void;
  className?: string;
}

export function ModelPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: ModelPickerProps<T>): React.ReactElement {
  const selectOptions: SelectOption[] = options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    searchKey: opt.label,
    ...(opt.disabled ? { disabled: true } : {}),
  }));

  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span className="t-meta flex items-center uppercase tracking-[0.06em] text-sc-text-2">
        {label}
      </span>
      <Select
        value={value}
        onChange={(next) => onChange(next as T)}
        options={selectOptions}
        ariaLabel={label}
      />
    </label>
  );
}
