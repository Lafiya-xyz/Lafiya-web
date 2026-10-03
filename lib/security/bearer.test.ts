import { describe, expect, it } from "vitest";

import { verifyBearer } from "./bearer";

function request(authorization?: string): Request {
  return new Request("http://localhost/internal", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("verifyBearer", () => {
  it("accepts a configured bearer token", () => {
    expect(verifyBearer(request("Bearer current-secret"), ["current-secret"])).toBe(
      true,
    );
  });

  it("checks every configured secret", () => {
    expect(
      verifyBearer(request("Bearer previous-secret"), [
        "current-secret",
        "previous-secret",
      ]),
    ).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyBearer(request("Bearer wrong-secret"), ["current-secret"])).toBe(
      false,
    );
  });

  it("rejects a missing or malformed authorization header", () => {
    expect(verifyBearer(request(), ["current-secret"])).toBe(false);
    expect(verifyBearer(request("Basic current-secret"), ["current-secret"])).toBe(
      false,
    );
    expect(verifyBearer(request("Bearer"), ["current-secret"])).toBe(false);
    expect(verifyBearer(request("Bearer token extra"), ["current-secret"])).toBe(
      false,
    );
  });
});
