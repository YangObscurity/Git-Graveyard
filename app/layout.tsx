import type { Metadata } from "next";
import "./globals.css";
import "../styles/accessibility.css";
import { CryptNav } from "@/components/ui/CryptNav";
import { UiDebugBootstrap } from "@/components/ui/UiDebugBootstrap";
import { SkipLink } from "@/components/a11y/SkipLink";
import {
  AriaAnnouncerProvider,
  AccessibilityControls,
} from "@/components/a11y/AriaAnnouncer";

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
        <AriaAnnouncerProvider>
          <SkipLink />
          <CryptNav />
          <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </div>
          <aside
            aria-label="Accessibility controls and live announcements"
            className="border-t border-white/10 bg-[#0b0d11]/95"
          >
            <AccessibilityControls />
          </aside>
          <UiDebugBootstrap />
        </AriaAnnouncerProvider>
      </body>
    </html>
  );
}
