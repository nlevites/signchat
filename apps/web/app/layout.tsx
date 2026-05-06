import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { ToastContainer } from "@/components/ui/Toast";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Signchat",
  description: "real-time sign-to-voice video chat",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        {/* small (~20 KB) still frame of the hero video so the dusk
            scene paints instantly while the 4 MB mp4 streams in. */}
        <link
          rel="preload"
          as="image"
          href="/hero-header/hero-bg-poster.webp"
          type="image/webp"
        />
      </head>
      <body className="antialiased">
        {children}
        <ToastContainer />
      </body>
    </html>
  );
}
