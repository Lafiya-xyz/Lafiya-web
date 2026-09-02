"use client";

export function DownloadCardButton({
  cardUrl,
  card,
}: {
  cardUrl: string;
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
  const handleDownload = () => {
    const win = window.open("", "_blank", "width=600,height=800");
    if (!win) return;

    const doc = win.document;
    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
  <title>Emergency Card - ${card.name ?? "Patient"}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 400px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .meta { color: #666; font-size: 14px; margin-bottom: 16px; }
    .section { margin-bottom: 16px; }
    .label { font-size: 12px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
    .value { font-size: 16px; margin-top: 2px; }
    .qr { text-align: center; margin: 16px 0; }
    .qr img { width: 200px; height: 200px; }
    .contact { border: 1px solid #e5e5e5; padding: 8px; border-radius: 4px; margin-bottom: 8px; }
    @media print {
      body { padding: 0; }
      button { display: none; }
    }
  </style>
</head>
<body>
  <button onclick="window.print()" style="margin-bottom: 16px; padding: 8px 16px; cursor: pointer;">Save as PDF / Print</button>
  <h1>Emergency Card</h1>
  <p class="meta">${card.name ?? "Name withheld"}${card.age !== null ? ` · ${card.age} years old` : ""}</p>
  <div class="qr">
    <img src="${cardUrl}" alt="QR code" />
    <p style="font-size: 12px; color: #666; word-break: break-all;">${cardUrl}</p>
  </div>
  <div class="section">
    <div class="label">Blood group</div>
    <div class="value">${card.blood_group ?? "Withheld"}</div>
  </div>
  <div class="section">
    <div class="label">Genotype</div>
    <div class="value">${card.genotype ?? "Withheld"}</div>
  </div>
  <div class="section">
    <div class="label">Allergies</div>
    <div class="value">${(card.allergies ?? []).length > 0 ? (card.allergies ?? []).join(", ") : "None recorded"}</div>
  </div>
  <div class="section">
    <div class="label">Current medications</div>
    <div class="value">${(card.medications ?? []).length > 0 ? (card.medications ?? []).join(", ") : "None recorded"}</div>
  </div>
  <div class="section">
    <div class="label">Chronic conditions / implants</div>
    <div class="value">${(card.chronic_conditions ?? []).length > 0 ? (card.chronic_conditions ?? []).join(", ") : "None recorded"}</div>
  </div>
  ${card.emergency_contacts && card.emergency_contacts.length > 0 ? `
  <div class="section">
    <div class="label">Emergency contacts</div>
    ${card.emergency_contacts.map((c) => `
      <div class="contact">
        <div class="value" style="font-weight: 600;">${c.name}</div>
        <div class="value" style="font-size: 14px; color: #666;">${c.relationship}</div>
        <div class="value" style="font-size: 14px;">${c.phone}</div>
      </div>
    `).join("")}
  </div>
  ` : ""}
  <div class="section">
    <div class="label">Language spoken</div>
    <div class="value">${card.language ?? "Not specified"}</div>
  </div>
  <p style="font-size: 11px; color: #999; margin-top: 24px;">Not a medical device. Not a substitute for professional medical judgment.</p>
</body>
</html>`);
    doc.close();
    win.focus();
    setTimeout(() => win.print(), 250);
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
