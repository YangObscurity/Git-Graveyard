import { GateView } from "@/components/GateView";

export default function Home() {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <GateView />
      </div>
    </main>
  );
}
