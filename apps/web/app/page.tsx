import { HeroHeader } from "@/components/landing/HeroHeader";
import { IntegrationsBand } from "@/components/landing/HeroHeader/IntegrationsBand";
import { ImpactBand } from "@/components/landing/ImpactBand";
import { SignchatSuite } from "@/components/landing/SignchatSuite";
import { Footer } from "@/components/landing/Footer";

export default function Home() {
  return (
    <>
      <HeroHeader />
      <div className="sc-branded-frame">
        <IntegrationsBand />
        <ImpactBand />
        <SignchatSuite />
      </div>
      <Footer />
    </>
  );
}
