/**
 * AES-256-GCM helpers for the secrets vault. Master key from env
 * SABLE_VAULT_KEY (32+ byte secret or base64). Never log plaintext.
 */
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;

export type Sealed = { v: 1; iv: string; tag: string; ct: string };

export function vaultOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SABLE_VAULT ?? "1").trim() !== "0";
}

export function deriveKey(secret: string, salt: Buffer): Buffer {
  return crypto.scryptSync(secret, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

export function resolveMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.SABLE_VAULT_KEY?.trim();
  if (!raw) return null;
  if (/^[A-Za-z0-9+/=]+$/.test(raw) && raw.length >= 44) {
    try {
      const buf = Buffer.from(raw, "base64");
      if (buf.length === KEY_LEN) return buf;
    } catch {
      /* fall through */
    }
  }
  // Stretch arbitrary passphrase with a fixed app salt (per-install salt lives in vault meta).
  return deriveKey(raw, Buffer.from("sable-vault-v1", "utf8"));
}

export function seal(plaintext: string, key: Buffer): Sealed {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function open(sealed: Sealed, key: Buffer): string {
  if (sealed.v !== 1) throw new Error("unsupported vault blob version");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]).toString("utf8");
}
