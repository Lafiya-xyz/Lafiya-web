import type { Metadata } from "next";
import { OfflinePacksPanel } from "./offline-packs-panel";
import { ScannerView } from "./scanner-view";
import { ShiftVaultPanel } from "./shift-vault-panel";

export const metadata: Metadata = {
  title: "Scan Emergency Card | Lafiya",
  description: "In-app QR scanner for first responders to instantly read patient emergency cards.",
};

export default function ScanPage() {
  return (
    <main className="min-h-screen bg-black">
      <ScannerView />
      <ShiftVaultPanel />
      <OfflinePacksPanel />
    </main>
  );
}
