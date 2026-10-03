import { createHash, timingSafeEqual } from "node:crypto";

export function verifyBearer(request: Request, secrets: string[]): boolean {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(\S+)$/i);
  if (!match) return false;

  const tokenDigest = createHash("sha256").update(match[1], "utf8").digest();
  let authorized = false;

  for (const secret of secrets) {
    const secretDigest = createHash("sha256").update(secret, "utf8").digest();
    authorized = timingSafeEqual(tokenDigest, secretDigest) || authorized;
  }

  return authorized;
}
