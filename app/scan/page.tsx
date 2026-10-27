import type { Metadata } from "next";
import { ScannerView } from "./scanner-view";

export const metadata: Metadata = {
  title: "Scan Emergency Card | Lafiya",
  description: "In-app QR scanner for first responders to instantly read patient emergency cards.",
};

export default function ScanPage() {
  return (
    <main className="min-h-screen bg-black">
      <ScannerView />
    </main>
  );
}
