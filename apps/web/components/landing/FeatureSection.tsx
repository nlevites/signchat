import { HandWaving, SpeakerHigh } from "@phosphor-icons/react/dist/ssr";
import { FeatureCard } from "./FeatureCard";

export function FeatureSection() {
  return (
    <section className="bg-sc-bg py-20">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-16 px-6">
        <h2 className="t-display max-w-[720px] text-sc-text">
          One link. Two browsers. No interpreter.
        </h2>
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <FeatureCard
            icon={<HandWaving size={20} weight="regular" />}
            label="for the deaf signer"
            heading="Sign naturally, get spoken"
            body="Local sign recognition runs in your browser. The reconstructed sentence streams as synthetic speech mixed with your real microphone — one stable voice channel, no track churn."
          />
          <FeatureCard
            icon={<SpeakerHigh size={20} weight="regular" />}
            label="for the hearing peer"
            heading="See what's being said"
            body="Live word-by-word captions of your own voice on the deaf user's tile, plus the reconstructed sentence pinned in lock-step with the audio it's narrating."
          />
        </div>
      </div>
    </section>
  );
}
