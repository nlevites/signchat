import type { Metadata } from "next";
import { BridgePage } from "@/components/landing/BridgePage";

export const metadata: Metadata = {
  title: "Signchat Bridge — your voice in every call",
  description:
    "Sign Chat Bridge is a macOS desktop companion that routes the Signchat audio graph into a system-level virtual mic so your signs become spoken sentences in FaceTime, Zoom, Meet, Teams, or Discord.",
};

export default function BridgeRoute() {
  return <BridgePage />;
}
