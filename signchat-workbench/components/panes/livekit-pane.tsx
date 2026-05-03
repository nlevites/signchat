"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function LiveKitPane() {
  useEffect(() => {
    LogBus.debug("livekit", "livekit pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="LiveKit transport"
      phase="Phase 2"
      summary="Join a LiveKit room with the lobby's minted JWT. Render local + remote tracks. Send and receive arbitrary RoomDataMessage with the right reliability per kind (§6.3). Wired up in Phase 2."
      bullets={[
        "Local participant tile (camera + mic preview)",
        "Remote participants list + their tracks",
        "DataChannel composer: kind dropdown + text body + send",
        "Inbox tail of every RoomDataMessage received, kind-color-coded",
        "Connection state badge (livekit-client emits these natively)",
      ]}
    />
  );
}
