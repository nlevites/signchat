import { StartForm } from "@/components/start/StartForm";
import { Logo } from "@/components/ui/Logo";

export default function StartPage() {
  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-sc-bg px-6 py-12">
      <div className="w-full max-w-[480px]">
        <div className="mb-8 flex items-center justify-center">
          <Logo size={80} wordmarkSize={48} surface="solid" />
        </div>
        <div className="rounded-sc-2xl border border-sc-border bg-sc-surface p-8 shadow-sc-lg">
          <header className="mb-6 flex flex-col gap-2">
            <h1 className="t-h1 text-sc-text">Start or join a call</h1>
            <p className="t-body-sm text-sc-text-2">
              Pick your role and either create a new room or enter a room code to
              join an existing one.
            </p>
          </header>
          <StartForm />
        </div>
      </div>
    </main>
  );
}
