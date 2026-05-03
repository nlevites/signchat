import { Logo } from "@/components/ui/Logo";

export function Footer() {
  return (
    <footer className="bg-aubergine py-36 px-24">
      <div className="mx-auto max-w-[1200px] flex items-center justify-between">
        <Logo size={72} wordmarkSize={45} surface="overlay" />
        <div className="text-caption text-bone/60">BeaverHacks 2026 · v0.1.0</div>
      </div>
    </footer>
  );
}
