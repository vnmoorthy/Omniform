import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OmniForm — Ambient Biomechanics Lab",
  description:
    "Hold to capture motion. Release for instant kinematic coaching, powered by Gemini.",
};

export const viewport: Viewport = {
  themeColor: "#05060a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className="bg-omni-bg text-white antialiased">{children}</body>
    </html>
  );
}
