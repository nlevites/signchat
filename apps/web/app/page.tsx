import { NavBar } from "@/components/landing/NavBar";
import { Hero } from "@/components/landing/Hero";
import { FeatureSection } from "@/components/landing/FeatureSection";
import { Footer } from "@/components/landing/Footer";

export default function Home() {
  return (
    <>
      <NavBar />
      <Hero />
      <FeatureSection />
      <Footer />
    </>
  );
}
