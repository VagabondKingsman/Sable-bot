/**
 * Secret scrubbing for anything that is about to be stored as a memory (or
 * shown in a channel log). Pure and conservative: a false positive costs a
 * word, a false negative leaks a credential into a file that outlives the chat.
 */

const MASK = "[đã ẩn]";

/** Luhn check on a digit string (card-like numbers only count when it passes). */
export function luhn(digits: string) {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return digits.length > 0 && sum % 10 === 0;
}

type Rule = { name: string; re: RegExp; replace?: (match: string, ...groups: string[]) => string | null };

const RULES: Rule[] = [
  { name: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // Provider keys and tokens with a recognizable prefix.
  { name: "api_key", re: /\b(?:sk|xai|pk|rk)-(?:[A-Za-z0-9_-]*-)?[A-Za-z0-9_-]{12,}\b/g },
  { name: "github", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "slack", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google", re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  // W2b: Google OAuth access / refresh tokens, client secrets, auth codes in URLs.
  { name: "google_oauth", re: /\bya29\.[A-Za-z0-9._-]{10,}/g },
  { name: "google_refresh", re: /\b1\/\/[A-Za-z0-9._-]{10,}/g },
  { name: "google_client_secret", re: /\bGOCSPX-[A-Za-z0-9_-]{10,}/g },
  { name: "oauth_param", re: /([?&](?:code|access_token|refresh_token|id_token|client_secret|code_verifier)=)[^&\s"']+/gi, replace: (_m, k) => `${k}[đã ẩn]` },
  { name: "oauth_json", re: /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]+"/gi, replace: (_m, k) => `${k}[đã ẩn]"` },
  { name: "telegram", re: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "ngrok", re: /\b[0-9][A-Za-z0-9]{20,}_[A-Za-z0-9]{15,}\b/g },
  { name: "bearer", re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_m, kind) => `${kind} ${MASK}` },
  // URL credentials: scheme://user:pass@host
  { name: "url_cred", re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s/@]+)@/gi, replace: (_m, scheme, user) => `${scheme}${user}:${MASK}@` },
  // "password: hunter2", "mật khẩu là abc", "token=…", "api key …", "otp 123456", "cvv 123", "pin 1234"
  {
    name: "labeled",
    re: /\b(passwords?|passwd|pwd|pass(?:code|phrase)?|mật\s*khẩu|mat\s*khau|mk|secret|token|api[\s_-]*key|access[\s_-]*key|auth[\s_-]*key|private[\s_-]*key|otp|cvv|cvc|pin|seed\s*phrase|khóa\s*bí\s*mật)((?:\s+[\p{L}\p{N}_.-]{1,24}){0,3}?\s*(?:là|la|is|=|:|：)\s*|\s+)(["'`]?)([^\s"'`,;]{3,})\3/giu,
    replace: (_m, label, sep, _q, value) => {
      // "token limit", "pin this", "secret sauce": a bare word after a space is not a value.
      // With an explicit "là / is / = / :" anything counts; otherwise it must look like one.
      const explicit = /(?:[:=：]|(?:^|\s)(?:là|la|is))\s*$/iu.test(sep);
      if (!explicit && !/[0-9]/.test(value) && !/[^\p{L}]/u.test(value)) return null;
      // "mật khẩu wifi là X": words between the label and "là" make it weaker; the value must look like one.
      const qualified = /[\p{L}\p{N}]/u.test(sep.replace(/(?:[:=：]|(?:^|\s)(?:là|la|is))\s*$/iu, ""));
      if (qualified && !(value.length >= 6 && /[0-9]/.test(value))) return null;
      return `${label}${sep}${MASK}`;
    },
  },
  // Generic long secrets: 32+ chars mixing letters and digits with no spaces (hex digests, base64 keys).
  {
    name: "long_token",
    re: /\b[A-Za-z0-9_+/=-]{32,}\b/g,
    replace: (match) => (/[0-9]/.test(match) && /[A-Za-z]/.test(match) ? MASK : null),
  },
  // Card-like numbers: 13–19 digits (spaces/dashes allowed) that pass Luhn.
  {
    name: "card",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    replace: (match) => (luhn(match.replace(/[ -]/g, "")) ? MASK : null),
  },
];

export type Redaction = { text: string; hits: string[] };

/** Replace anything secret-looking with a mask. Returns which rules fired. */
export function redactSecrets(input: string): Redaction {
  let text = String(input ?? "");
  const hits: string[] = [];
  for (const rule of RULES) {
    text = text.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((item) => typeof item === "string") as string[];
      const out = rule.replace ? rule.replace(match, ...groups) : MASK;
      if (out === null) return match;
      if (!hits.includes(rule.name)) hits.push(rule.name);
      return out;
    });
  }
  return { text, hits };
}

const CREDENTIAL_TOPIC =
  /\b(passwords?|mật\s*khẩu|mat\s*khau|token|api[\s_-]*key|secret|otp|cvv|cvc|pin|private[\s_-]*key|seed|thẻ\s*tín\s*dụng|credit\s*card|số\s*thẻ|card\s*number)\b/iu;

/**
 * Clean one memory candidate. Returns null when it should not be stored at all:
 * empty, or it was about a credential (a fact like "my password is [masked]" is
 * useless and still advertises the secret exists).
 */
export function sanitizeMemoryText(raw: string, max = 300): string | null {
  const collapsed = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const { text, hits } = redactSecrets(collapsed);
  if (hits.length && CREDENTIAL_TOPIC.test(collapsed)) return null;
  const meaningful = text.replaceAll(MASK, "").replace(/[^\p{L}\p{N}]+/gu, "");
  if (meaningful.length < 3) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export const REDACTION_MASK = MASK;
