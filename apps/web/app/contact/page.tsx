import type { Metadata } from "next";
import { ContactPage } from "@/components/landing/ContactPage";

export const metadata: Metadata = {
  title: "Contact — Signchat",
  description:
    "Talk to the people who built Signchat. Send Adil or Nathan a message on LinkedIn, or open an issue on GitHub for anything code-shaped.",
};

export default function ContactRoute() {
  return <ContactPage />;
}
