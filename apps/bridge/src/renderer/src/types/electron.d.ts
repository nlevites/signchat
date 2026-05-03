import "react";

declare module "react" {
  interface CSSProperties {
    /** Electron-only: drag the window from this region (vendor-prefixed). */
    WebkitAppRegion?: "drag" | "no-drag";
  }
}
