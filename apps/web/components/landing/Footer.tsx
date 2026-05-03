import { Logo } from "@/components/ui/Logo";

export function Footer() {
  return (
    <footer className="sc-footer-surface px-6 py-12">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between">
        <Logo size={56} wordmarkSize={36} surface="overlay" />
        <div className="t-meta uppercase text-white/50">
          BeaverHacks 2026 · v0.1.0
        </div>
      </div>
    </footer>
  );
}
