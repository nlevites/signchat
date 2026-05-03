import { StartForm } from "@/components/start/StartForm";
import { Logo } from "@/components/ui/Logo";
import { PreflightShell, preflightShell } from "@/components/shells/PreflightShell";

export default function StartPage() {
  return (
    <PreflightShell
      hero={<Logo size={72} wordmarkSize={44} surface="overlay" />}
    >
      <header className={preflightShell.pageHead}>
        <h1>Start or join a call</h1>
        <p>
          Pick your role and either create a new room or enter a room code to
          join an existing one.
        </p>
      </header>
      <StartForm />
    </PreflightShell>
  );
}
