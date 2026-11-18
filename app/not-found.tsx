import Link from "next/link";
import { CryptOrnament } from "@/components/ui/CryptOrnament";

export default function NotFound() {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div
        data-testid="not-found"
        data-ui-element="not-found"
        data-ui-state="ready"
        className="max-w-2xl mx-auto crypt-panel-engraved p-10 text-center space-y-4"
      >
        <CryptOrnament kind="tomb-arch" className="w-28 h-9 text-ash mx-auto" />
        <h1 className="font-serif-ritual text-2xl md:text-3xl font-bold text-bone">
          Nothing is buried here
        </h1>
        <p className="text-xs text-ash leading-relaxed">
          This page does not exist. Check the address, start from the Gate, or
          pick a recorded run from History.
        </p>
        <div className="flex flex-wrap justify-center gap-3 pt-2">
          <Link href="/" className="crypt-btn-primary px-4 py-2 rounded text-xs">
            Return to Gate
          </Link>
          <Link href="/history" className="crypt-btn-ghost px-4 py-2 rounded text-xs">
            Open History
          </Link>
        </div>
      </div>
    </main>
  );
}
