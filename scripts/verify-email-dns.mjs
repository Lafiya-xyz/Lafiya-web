#!/usr/bin/env node
// Verifies SPF, DKIM and DMARC records for the email sending domain (#802).
// Usage: node scripts/verify-email-dns.mjs <domain> [dkim-selector ...]
import { resolveTxt } from "node:dns/promises";

const [domain, ...selectors] = process.argv.slice(2);
if (!domain) {
  console.error("usage: verify-email-dns.mjs <domain> [dkim-selector ...]");
  process.exit(2);
}

async function txt(name) {
  try {
    return (await resolveTxt(name)).map((parts) => parts.join(""));
  } catch {
    return [];
  }
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

const spf = (await txt(domain)).filter((r) => r.startsWith("v=spf1"));
check("SPF", spf.length === 1 && /[-~]all\b/.test(spf[0]), spf[0] ?? "missing");

const dmarc = (await txt(`_dmarc.${domain}`)).find((r) => r.startsWith("v=DMARC1"));
check("DMARC", Boolean(dmarc && /p=(quarantine|reject)/.test(dmarc)), dmarc ?? "missing");

for (const s of selectors.length ? selectors : ["s1", "s2"]) {
  const rec = (await txt(`${s}._domainkey.${domain}`)).find((r) => r.includes("p="));
  check(`DKIM (${s})`, Boolean(rec), rec ? "present" : "missing");
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
