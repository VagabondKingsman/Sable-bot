/** PKCE (RFC 7636, S256) + state helpers. */
import crypto from "node:crypto";

export const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 64 random bytes → 86-char verifier (RFC: 43..128 unreserved chars). */
export function newVerifier() {
  return b64url(crypto.randomBytes(64));
}

export function challengeOf(verifier: string) {
  return b64url(crypto.createHash("sha256").update(verifier).digest());
}

export function newState() {
  return b64url(crypto.randomBytes(32));
}

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
