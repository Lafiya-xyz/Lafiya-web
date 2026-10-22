import { afterEach, describe, expect, it, vi } from "vitest";

import { computeSunMac, deriveTagKeys, encryptPiccData } from "@/lib/nfc/sun";

import { GET } from "./route";

const keyHex = "00112233445566778899aabbccddeeff";
const uid = Buffer.from("04aabbccddeeff", "hex");

function url(counter: number, tamper = false) {
  const keys = deriveTagKeys(Buffer.from(keyHex, "hex"), uid);
  const picc = encryptPiccData(keys.metaReadKey, uid, counter).toString("hex");
  let cmac = computeSunMac(keys.fileReadKey, uid, counter).toString("hex");
  if (tamper) cmac = cmac.split("").reverse().join("");
  return new Request(
    `https://lafiya.test/api/nfc/sun?picc=${picc}&cmac=${cmac}`,
  );
}

describe("GET /api/nfc/sun", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns 501 when unconfigured", async () => {
    vi.stubEnv("NFC_SUN_MASTER_KEY", "");
    expect((await GET(url(1))).status).toBe(501);
  });

  it("accepts once, then rejects replay (409) and tampering (400)", async () => {
    vi.stubEnv("NFC_SUN_MASTER_KEY", keyHex);
    expect((await GET(url(10))).status).toBe(200);
    expect((await GET(url(10))).status).toBe(409);
    expect((await GET(url(11, true))).status).toBe(400);
  });
});
