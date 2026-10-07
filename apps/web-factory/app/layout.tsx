import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Web Factory", template: "%s — Web Factory" },
  description: "Cloud monitoring and control of Z-Factory installations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
