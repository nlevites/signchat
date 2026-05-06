import type { Metadata } from "next";
import { PricingPage } from "@/components/landing/PricingPage";

export const metadata: Metadata = {
  title: "Signchat pricing — free forever, open source",
  description:
    "Signchat is free for everyone, forever. The full sign-to-voice and live-captions pipeline runs in your browser with no relay. Enterprise tier available with SSO and SLA.",
};

export default function PricingRoute() {
  return <PricingPage />;
}
