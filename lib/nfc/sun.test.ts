import { describe, expect, it } from "vitest";

import {
  aesCmac,
  computeSunMac,
  deriveTagKeys,
  encryptPiccData,
  memoryCounterStore,
  verifySunMessage,
} from "./sun";

const master = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const uid = Buffer.from("04de5f1eacc040", "hex");

function tagRead(counter: number) {
  const keys = deriveTagKeys(master, uid);
  return {
    picc: encryptPiccData(keys.metaReadKey, uid, counter).toString("hex"),
    cmac: computeSunMac(keys.fileReadKey, uid, counter).toString("hex"),
  };
}

describe("AES-CMAC", () => {
  // RFC 4493 test vectors.
  const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
  it("matches the empty-message vector", () => {
    expect(aesCmac(key, Buffer.alloc(0)).toString("hex")).toBe(
      "bb1d6929e95937287fa37d129b756746",
    );
  });
  it("matches the 16-byte vector", () => {
    const m = Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex");
    expect(aesCmac(key, m).toString("hex")).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
  });
  it("matches the 40-byte vector", () => {
    const m = Buffer.from(
      "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411",
      "hex",
    );
    expect(aesCmac(key, m).toString("hex")).toBe(
      "dfa66747de9ae63030ca32611497c827",
    );
  });
});

describe("verifySunMessage", () => {
  it("accepts a fresh message and rejects its replay", async () => {
    const store = memoryCounterStore();
    const msg = tagRead(5);
    expect(await verifySunMessage(msg, master, store)).toEqual({
      ok: true,
      uid: uid.toString("hex"),
      counter: 5,
    });
    expect(await verifySunMessage(msg, master, store)).toEqual({
      ok: false,
      reason: "REPLAYED",
    });
    expect(await verifySunMessage(tagRead(4), master, store)).toEqual({
      ok: false,
      reason: "REPLAYED",
    });
    expect((await verifySunMessage(tagRead(6), master, store)).ok).toBe(true);
  });

  it("rejects a tampered MAC", async () => {
    const msg = tagRead(1);
    const cmac = (msg.cmac[0] === "0" ? "1" : "0") + msg.cmac.slice(1);
    expect(
      await verifySunMessage({ ...msg, cmac }, master, memoryCounterStore()),
    ).toEqual({
      ok: false,
      reason: "TAMPERED",
    });
  });

  it("rejects tampered PICC data", async () => {
    const msg = tagRead(1);
    const picc = (msg.picc[31] === "0" ? "1" : "0") + msg.picc.slice(0, 31);
    const result = await verifySunMessage(
      { ...msg, picc },
      master,
      memoryCounterStore(),
    );
    expect(result).toEqual({ ok: false, reason: "TAMPERED" });
  });

  it("rejects a message from a tag keyed under another master", async () => {
    const other = Buffer.alloc(16, 7);
    expect(
      await verifySunMessage(tagRead(1), other, memoryCounterStore()),
    ).toMatchObject({
      ok: false,
      reason: "TAMPERED",
    });
  });

  it("rejects malformed input", async () => {
    expect(
      await verifySunMessage(
        { picc: "zz", cmac: "00" },
        master,
        memoryCounterStore(),
      ),
    ).toEqual({ ok: false, reason: "MALFORMED" });
  });
});
