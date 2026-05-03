import Image from "next/image";
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";

interface LogoProps {
  size?: number;
  showWordmark?: boolean;
  glow?: boolean;
  className?: string;
  wordmarkSize?: number;
  /** "overlay" — full-color 3D PNGs (use on dark/photo bg).
   *  "solid"  — brand-gradient silhouette via mask-image (use on light surfaces). */
  surface?: "overlay" | "solid";
}

const MASK_COMMON: CSSProperties = {
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
  WebkitMaskSize: "contain",
  maskSize: "contain",
  background: "var(--sc-accent-gradient)",
};

export function Logo({
  size = 28,
  showWordmark = true,
  glow = false,
  className,
  wordmarkSize = 28,
  surface = "overlay",
}: LogoProps) {
  const wordmarkHeight = Math.round(wordmarkSize * 1.8);
  const wordmarkWidth = Math.round(wordmarkHeight * 1.5);
  const markAria = showWordmark ? undefined : "Signchat";
  // wordmark png ships with ~30% transparent left padding; pull it in to close the gap.
  const wordmarkPullLeft = -Math.round(wordmarkHeight * 0.45);

  return (
    <span className={cn("inline-flex items-center", className)}>
      <span
        className="relative inline-flex shrink-0"
        style={{ width: size, height: size }}
      >
        {glow ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -inset-[40%] rounded-full blur-2xl opacity-70"
            style={{
              background:
                "radial-gradient(closest-side, rgba(117,120,240,0.65), rgba(188,190,249,0.28) 55%, transparent 80%)",
            }}
          />
        ) : null}
        {surface === "solid" ? (
          <span
            role="img"
            aria-label={markAria}
            className="relative z-[1] block"
            style={{
              ...MASK_COMMON,
              width: size,
              height: size,
              WebkitMaskImage: "url('/brand/logo-no-bg.png')",
              maskImage: "url('/brand/logo-no-bg.png')",
            }}
          />
        ) : (
          <Image
            src="/brand/logo-no-bg.png"
            alt={markAria ?? ""}
            width={size}
            height={size}
            priority
            className="relative z-[1]"
          />
        )}
      </span>
      {showWordmark ? (
        surface === "solid" ? (
          <span
            role="img"
            aria-label="Signchat"
            className="block shrink-0"
            style={{
              ...MASK_COMMON,
              width: wordmarkWidth,
              height: wordmarkHeight,
              marginLeft: wordmarkPullLeft,
              WebkitMaskImage: "url('/brand/signchat-logo-header-footer.png')",
              maskImage: "url('/brand/signchat-logo-header-footer.png')",
            }}
          />
        ) : (
          <Image
            src="/brand/signchat-logo-header-footer.png"
            alt="Signchat"
            width={wordmarkWidth}
            height={wordmarkHeight}
            priority
            className="shrink-0"
            style={{ marginLeft: wordmarkPullLeft }}
          />
        )
      ) : null}
    </span>
  );
}
