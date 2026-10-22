"use client";

export function DownloadCardButton({
  cardUrl,
  card,
  cardPin,
}: {
  cardUrl: string;
  /** Issue #631: printed on a separate panel, away from the QR code. */
  cardPin?: string;
  card: {
    name: string | null;
    age: number | null;
    blood_group: string | null;
    genotype: string | null;
    allergies: string[] | null;
    medications: string[] | null;
    chronic_conditions: string[] | null;
    emergency_contacts: Array<{ name: string; phone: string; relationship: string }> | null;
    language: string | null;
    record_updated_at: string;
  };
}) {
  // Issue #773: a server-generated, tagged (PDF/UA) PDF replaces the
  // browser-printed HTML window, which produced untagged PDFs.
  const handleDownload = async () => {
    const { record_updated_at: _updatedAt, ...visible } = card;
    void _updatedAt;
    const res = await fetch("/api/card/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card: visible, cardUrl, cardPin }),
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = "lafiya-emergency-card.pdf";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      className="flex h-11 items-center justify-center rounded-full bg-zinc-950 px-6 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-950 dark:hover:bg-zinc-200"
    >
      Download card
    </button>
  );
}
