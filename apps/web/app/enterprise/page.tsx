import type { Metadata } from "next";
import { EnterprisePage } from "@/components/landing/EnterprisePage";

export const metadata: Metadata = {
  title: "Signchat for Teams — bring real-time ASL to every meeting",
  description:
    "Signchat for Teams adds SSO, private deployment, and a contractual SLA on top of the same open-source browser-direct sign-to-voice pipeline your employees already use.",
};

export default function EnterpriseRoute() {
  return <EnterprisePage />;
}
