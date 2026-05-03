import { useEffect, useState, type JSX } from "react";
import { Setup, type SetupResult } from "./pages/Setup";
import { Active } from "./pages/Active";

const SETUP_KEY = "bridge:setup-complete";

interface PersistedSetup {
  cameraDeviceId: string;
  micOutputDeviceId: string;
  loopbackInputDeviceId: string;
  voiceId: string;
}

function loadSetup(): PersistedSetup | null {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedSetup>;
    if (
      typeof parsed.cameraDeviceId !== "string" ||
      typeof parsed.micOutputDeviceId !== "string" ||
      typeof parsed.loopbackInputDeviceId !== "string" ||
      typeof parsed.voiceId !== "string"
    ) {
      return null;
    }
    return {
      cameraDeviceId: parsed.cameraDeviceId,
      micOutputDeviceId: parsed.micOutputDeviceId,
      loopbackInputDeviceId: parsed.loopbackInputDeviceId,
      voiceId: parsed.voiceId,
    };
  } catch {
    return null;
  }
}

function persistSetup(setup: PersistedSetup): void {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(setup));
  } catch {
    // ignore — running in a private context or quota exhausted
  }
}

export function App(): JSX.Element {
  const [setup, setSetup] = useState<PersistedSetup | null>(() => loadSetup());

  useEffect(() => {
    if (setup) persistSetup(setup);
  }, [setup]);

  const handleSetupDone = (result: SetupResult): void => {
    setSetup({
      cameraDeviceId: result.cameraDeviceId,
      micOutputDeviceId: result.micOutputDeviceId,
      loopbackInputDeviceId: result.loopbackInputDeviceId,
      voiceId: result.voiceId,
    });
  };

  const handleReconfigure = (): void => {
    setSetup(null);
  };

  if (!setup) {
    return <Setup initial={loadSetup()} onDone={handleSetupDone} />;
  }
  return (
    <Active
      cameraDeviceId={setup.cameraDeviceId}
      micOutputDeviceId={setup.micOutputDeviceId}
      loopbackInputDeviceId={setup.loopbackInputDeviceId}
      voiceId={setup.voiceId}
      onReconfigure={handleReconfigure}
    />
  );
}
