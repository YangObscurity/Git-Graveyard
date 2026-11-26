import type { Metadata } from "next";
import "./globals.css";
import { CryptNav } from "@/components/ui/CryptNav";
import { UiDebugBootstrap } from "@/components/ui/UiDebugBootstrap";

export const metadata: Metadata = {
  title: "Git-Graveyard",
  description: "Resurrect abandoned GitHub repositories",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="crypt-bg-atmosphere text-bone antialiased min-h-screen font-mono selection:bg-emerald-500/30 selection:text-emerald-200 flex flex-col">
        <CryptNav />
        <div className="flex-1">{children}</div>
        <UiDebugBootstrap />
      </body>
    </html>
  );
}
