"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { CaretDown, Check } from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/cn";

export interface SelectOption {
  value: string;
  label: React.ReactNode;
  description?: string;
  searchKey?: string;
  disabled?: boolean;
}

export type SelectTone = "light" | "dark";

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  tone?: SelectTone;
  className?: string;
  id?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  startSlot?: React.ReactNode;
}

export interface SelectHandle {
  focus: () => void;
  open: () => void;
}

function searchableLabel(opt: SelectOption): string {
  if (opt.searchKey) return opt.searchKey.toLowerCase();
  if (typeof opt.label === "string") return opt.label.toLowerCase();
  return opt.value.toLowerCase();
}

export const Select = forwardRef<SelectHandle, SelectProps>(function Select(
  {
    value,
    onChange,
    options,
    placeholder = "Select…",
    disabled,
    tone = "light",
    className,
    id,
    ariaLabel,
    ariaLabelledBy,
    startSlot,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<"bottom" | "top">("bottom");
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeBuf = useRef<{ buf: string; ts: number }>({ buf: "", ts: 0 });
  const ownId = useId();
  const listboxId = `${id ?? ownId}-listbox`;

  useEffect(() => setMounted(true), []);

  const selected = options.find((o) => o.value === value);

  useImperativeHandle(ref, () => ({
    focus: () => triggerRef.current?.focus(),
    open: () => setOpen(true),
  }));

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const reposition = useCallback(() => {
    if (!triggerRef.current || typeof window === "undefined") return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const popoverMax = window.innerHeight * 0.55;
    const estimated = Math.min(popoverMax, options.length * 44 + 16);
    const flip = spaceBelow < estimated && spaceAbove > spaceBelow;
    setPlacement(flip ? "top" : "bottom");
    setCoords({
      top: flip ? rect.top - 6 : rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    const i = options.findIndex((o) => o.value === value && !o.disabled);
    if (i >= 0) {
      setActiveIndex(i);
    } else {
      setActiveIndex(options.findIndex((o) => !o.disabled));
    }
    reposition();
  }, [open, value, options, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => reposition();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const node = listRef.current.querySelector<HTMLLIElement>(`[data-idx="${activeIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  const moveActive = useCallback(
    (delta: number) => {
      if (options.length === 0) return;
      let next = activeIndex;
      for (let i = 0; i < options.length; i++) {
        next = (next + delta + options.length) % options.length;
        const opt = options[next];
        if (opt && !opt.disabled) break;
      }
      setActiveIndex(next);
    },
    [activeIndex, options],
  );

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onChange],
  );

  const onTriggerKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Home":
        e.preventDefault();
        setActiveIndex(options.findIndex((o) => !o.disabled));
        break;
      case "End":
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) {
          const opt = options[i];
          if (opt && !opt.disabled) {
            setActiveIndex(i);
            break;
          }
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIndex >= 0) commit(activeIndex);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1) {
          // type-ahead — reset buffer if more than 700ms since last keypress.
          const now = Date.now();
          const buf = now - typeBuf.current.ts > 700 ? "" : typeBuf.current.buf;
          const next = (buf + e.key).toLowerCase();
          typeBuf.current = { buf: next, ts: now };
          const start = activeIndex >= 0 ? activeIndex : 0;
          for (let off = 1; off <= options.length; off++) {
            const i = (start + off) % options.length;
            const opt = options[i];
            if (!opt || opt.disabled) continue;
            if (searchableLabel(opt).startsWith(next)) {
              setActiveIndex(i);
              break;
            }
          }
        }
    }
  };

  const tonedTrigger =
    tone === "dark"
      ? "border-white/15 bg-black/40 text-white hover:border-white/30 focus-visible:border-sc-accent-500 disabled:opacity-50"
      : "border-sc-border bg-sc-surface text-sc-text hover:border-sc-border-strong focus-visible:border-sc-accent-500 disabled:opacity-50";

  const tonedPopover =
    tone === "dark"
      ? "border-white/15 bg-[#1f2569]/95 text-white"
      : "border-sc-border bg-sc-surface text-sc-text";

  return (
    <div className={cn("relative inline-block w-full", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onTriggerKey}
        className={cn(
          "relative flex h-10 w-full items-center gap-2 rounded-sc-md border px-3 pr-10 text-[13px] transition-[border-color,box-shadow,background-color] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none focus-visible:shadow-[var(--sc-glow-sm)] disabled:cursor-not-allowed",
          tonedTrigger,
        )}
      >
        {startSlot}
        <span
          className={cn(
            "flex-1 truncate text-left",
            !selected && (tone === "dark" ? "text-white/45" : "text-sc-text-3"),
          )}
        >
          {selected?.label ?? placeholder}
        </span>
        <CaretDown
          aria-hidden
          size={14}
          weight="bold"
          className={cn(
            "absolute right-3 top-1/2 -translate-y-1/2 transition-transform duration-200",
            open && "rotate-180",
            tone === "dark" ? "text-white/55" : "text-sc-text-2",
          )}
        />
      </button>

      {/* portal-render so an `overflow-y-auto` ancestor can't clip the popover.
          fixed coords are recomputed on scroll/resize via reposition(). */}
      {mounted && coords
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.ul
                  ref={listRef}
                  role="listbox"
                  id={listboxId}
                  initial={{ opacity: 0, y: placement === "bottom" ? 4 : -4, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: placement === "bottom" ? 4 : -4, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
                  style={{
                    position: "fixed",
                    top: coords.top,
                    left: coords.left,
                    width: coords.width,
                    transform: placement === "top" ? "translateY(-100%)" : undefined,
                  }}
                  className={cn(
                    "z-50 max-h-[55vh] overflow-y-auto rounded-sc-lg border p-1 shadow-sc-xl backdrop-blur-md",
                    tonedPopover,
                  )}
                >
                  {options.map((opt, i) => {
                    const isSelected = opt.value === value;
                    const isActive = i === activeIndex;
                    const baseRowDark = isActive ? "bg-white/12" : "hover:bg-white/8";
                    const baseRowLight = isActive
                      ? "bg-sc-accent-soft text-sc-accent-700"
                      : "hover:bg-sc-surface-2";
                    return (
                      <li
                        key={opt.value}
                        role="option"
                        data-idx={i}
                        aria-selected={isSelected}
                        aria-disabled={opt.disabled || undefined}
                        onClick={() => commit(i)}
                        onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                        className={cn(
                          "flex cursor-pointer items-start gap-2 rounded-sc-md px-2.5 py-2 text-[13px] transition-colors duration-100",
                          opt.disabled && "cursor-not-allowed opacity-50",
                          !opt.disabled && tone === "dark" && baseRowDark,
                          !opt.disabled && tone === "light" && baseRowLight,
                        )}
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block truncate">{opt.label}</span>
                          {opt.description ? (
                            <span
                              className={cn(
                                "mt-0.5 block truncate font-mono text-[11px]",
                                tone === "dark" ? "text-white/55" : "text-sc-text-3",
                              )}
                            >
                              {opt.description}
                            </span>
                          ) : null}
                        </span>
                        {isSelected ? (
                          <Check
                            size={14}
                            weight="bold"
                            className={cn(
                              "mt-0.5 shrink-0",
                              tone === "dark" ? "text-sc-accent-300" : "text-sc-accent-500",
                            )}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </motion.ul>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </div>
  );
});
