import type { Metadata, Viewport } from "next";
import { Archivo, Barlow, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Archivo and Barlow are the closest freely-licensed stand-ins for the
// Premier League's own PremierSans: a tight, slightly condensed grotesque
// for headings and a humanist workhorse for body copy. Oswald (used until
// v1.24) is far more condensed than anything the PL actually uses, and read
// as a newspaper masthead rather than a scoreboard.
const display = Archivo({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const body = Barlow({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
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
