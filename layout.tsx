import type { Metadata, Viewport } from "next";
import { Space_Grotesk, Inter, DM_Mono } from "next/font/google";
import "./globals.css";

// Space Grotesk for display, Inter for text, DM Mono for figures.
//
// The previous set (Archivo + Barlow + JetBrains Mono) was competent and
// completely anonymous — it could have been any dashboard. JetBrains Mono in
// particular is a CODE face, and using it for every price and points total
// made the app read as a developer tool rather than a sports product. Space
// Grotesk has an actual voice at display sizes, Inter is the most legible UI
// text face available, and DM Mono keeps figures aligned in tables without
// the terminal connotation.
const display = Space_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const body = Inter({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = DM_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "FPL Command Center",
  description:
    "Painel de gestão e decisão para a tua equipa de Fantasy Premier League.",
};

// Without this, mobile Safari renders the page at a 980px viewport and
// scales it down — so every responsive breakpoint below `md` would never
// fire on the device it was written for.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#37003C",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="pt-PT"
      className={`${display.variable} ${body.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
