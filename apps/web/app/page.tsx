import { HeroHeader } from "@/components/landing/HeroHeader";
import { IntegrationsBand } from "@/components/landing/HeroHeader/IntegrationsBand";
import { ImpactBand } from "@/components/landing/ImpactBand";
import { SignchatSuite } from "@/components/landing/SignchatSuite";
import { Footer } from "@/components/landing/Footer";
import { Reveal } from "@/components/ui/Reveal";

export default function Home() {
  return (
    <>
      <HeroHeader />
      <div className="sc-branded-frame">
        <Reveal><IntegrationsBand /></Reveal>
        <Reveal><ImpactBand /></Reveal>
        <Reveal><SignchatSuite /></Reveal>
      </div>
      <Footer />
    </>
  );
}
