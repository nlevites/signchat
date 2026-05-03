import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-super-sans-vf",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Signchat",
  description: "real-time sign-to-voice video chat",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-parchment-canvas text-ink antialiased">{children}</body>
    </html>
  );
}
