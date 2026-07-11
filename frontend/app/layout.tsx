import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Header } from "@/components/Header";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Sessão — Movies & TV Series",
  description:
    "A curated catalog of the best movies and TV series, Brazilian and international, classics and modern hits — with ratings, posters and trailers.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="flex min-h-screen flex-col bg-black text-zinc-100">
        <Header />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-white/5 px-4 py-6 text-center text-xs text-zinc-600 sm:px-8">
          Ratings from IMDb &amp; Rotten Tomatoes (via OMDb). Artwork &amp; trailers via TMDB.
        </footer>
      </body>
    </html>
  );
}
