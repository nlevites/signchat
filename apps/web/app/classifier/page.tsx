import type { Metadata } from "next";
import { ClassifierPage } from "@/components/landing/ClassifierPage";

export const metadata: Metadata = {
  title: "Signchat ASL Classifier — 250-sign Conv1D-Transformer in your browser",
  description:
    "A ~1.7M-parameter Conv1D-Transformer hybrid trained on Google Kaggle's asl-signs (PopSign 250) competition, served as ONNX and run on WebAssembly inside the Signchat web app. Fully open source.",
};

export default function ClassifierRoute() {
  return <ClassifierPage />;
}
