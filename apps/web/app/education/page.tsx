import type { Metadata } from "next";
import { EducationPage } from "@/components/landing/EducationPage";

export const metadata: Metadata = {
  title: "Signchat for schools — real-time ASL in every classroom",
  description:
    "Signchat is free for accredited schools and 501(c)(3) non-profits. Real-time ASL-to-voice and live captions for K–12, universities, and Deaf-studies programs — no installs, no accounts.",
};

export default function EducationRoute() {
  return <EducationPage />;
}
