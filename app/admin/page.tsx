import React from "react";
import { AdminDashboard } from "@/components/AdminDashboard";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-transparent text-bone p-4 md:p-8 font-mono">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* The dashboard renders only the sign-in state until an Admin is signed in. */}
        <AdminDashboard />
      </div>
    </main>
  );
}