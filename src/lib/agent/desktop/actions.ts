/**
 * W3: desktop actions — pure parse/validate, xdotool argv builders, and redacted
 * descriptions. Typed text reaches xdotool on stdin only (never argv / ps), and
 * text marked secret is never put in a label, card, trace or audit line.
 */

export type Bounds = { width: number; height: number };
export type Button = "left" | "middle" | "right";
export type DesktopAction =
  | { kind: "click"; x: number; y: number; button: Button; double: boolean }
  | { kind: "type"; text: string; secret: boolean; enter: boolean }
  | { kind: "key"; keys: string[] }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; amount: number; x?: number; y?: number }
  | { kind: "wait"; ms: number };

export const ACTION_KINDS = ["click", "type", "key", "scroll", "wait"] as const;
export const MAX_TYPE = 2_000;
export const MAX_KEYS = 6;
const KEY_RE = /^[A-Za-z0-9_]{1,24}(\+[A-Za-z0-9_]{1,24}){0,3}$/;
/** Combos that would kill the X server or switch VTs. */
const BANNED_KEYS = [/ctrl\+alt\+backspace/i, /ctrl\+alt\+f\d+/i, /^(xf86|terminate)/i];

type R<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (error: string): R<never> => ({ ok: false, error });

function int(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

function point(x: unknown, y: unknown, b: Bounds): R<{ x: number; y: number }> {
  const px = int(x);
  const py = int(y);
  if (px === null || py === null) return fail("x and y must be numbers (screen pixels)");
  if (px < 0 || py < 0 || px >= b.width || py >= b.height) return fail(`(${px},${py}) is outside the ${b.width}x${b.height} screen`);
  return { ok: true, value: { x: px, y: py } };
}

/** Validate a raw action object (from a tool call or the vision model). */
export function parseAction(raw: unknown, b: Bounds): R<DesktopAction> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("action must be an object");
  const a = raw as Record<string, unknown>;
  const kind = a.kind ?? a.action ?? a.type;
  switch (kind) {
    case "click": {
      const p = point(a.x, a.y, b);
      if (!p.ok) return p;
      const button = a.button === undefined ? "left" : a.button;
      if (button !== "left" && button !== "right" && button !== "middle") return fail("button must be left | right | middle");
      return { ok: true, value: { kind, ...p.value, button, double: a.double === true } };
    }
    case "type": {
      if (typeof a.text !== "string" || a.text.length === 0) return fail("text must be a non-empty string");
      if (a.text.length > MAX_TYPE) return fail(`text too long (max ${MAX_TYPE})`);
      // Control characters other than tab/newline are refused (xdotool would send odd keysyms).
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(a.text)) return fail("text contains control characters");
      return { ok: true, value: { kind, text: a.text, secret: a.secret === true, enter: a.enter === true } };
    }
    case "key": {
      const list = Array.isArray(a.keys) ? a.keys : typeof a.keys === "string" ? a.keys.trim().split(/\s+/) : typeof a.key === "string" ? [a.key] : [];
      if (list.length === 0 || list.length > MAX_KEYS) return fail(`keys: 1..${MAX_KEYS} xdotool key names like "Return" or "ctrl+l"`);
      const keys: string[] = [];
      for (const k of list) {
        if (typeof k !== "string" || !KEY_RE.test(k)) return fail(`invalid key "${String(k).slice(0, 30)}"`);
        if (BANNED_KEYS.some((re) => re.test(k))) return fail(`key "${k}" is not allowed`);
        keys.push(k);
      }
      return { ok: true, value: { kind, keys } };
    }
    case "scroll": {
      const direction = a.direction ?? "down";
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") return fail("direction must be up | down | left | right");
      const amount = int(a.amount ?? 3);
      if (amount === null || amount < 1 || amount > 15) return fail("amount must be 1..15");
      if (a.x !== undefined || a.y !== undefined) {
        const p = point(a.x, a.y, b);
        if (!p.ok) return p;
        return { ok: true, value: { kind, direction, amount, ...p.value } };
      }
      return { ok: true, value: { kind, direction, amount } };
    }
    case "wait": {
      const ms = int(a.ms ?? (typeof a.seconds === "number" ? a.seconds * 1000 : 1000));
      if (ms === null || ms < 100 || ms > 10_000) return fail("ms must be 100..10000");
      return { ok: true, value: { kind, ms } };
    }
    default:
      return fail(`unknown action kind "${String(kind).slice(0, 20)}" (click | type | key | scroll | wait)`);
  }
}

/** Every action except wait needs an owner approval card (D2). */
export const needsApproval = (a: DesktopAction) => a.kind !== "wait";

const BUTTONS: Record<Button, string> = { left: "1", middle: "2", right: "3" };
const SCROLL: Record<string, string> = { up: "4", down: "5", left: "6", right: "7" };

/** xdotool invocations (argv + optional stdin) for one action. wait → none. */
export function xdotoolSteps(a: DesktopAction): { args: string[]; input?: string }[] {
  switch (a.kind) {
    case "click":
      return [{ args: ["mousemove", "--sync", String(a.x), String(a.y), "click", ...(a.double ? ["--repeat", "2", "--delay", "80"] : []), BUTTONS[a.button]] }];
    case "type": {
      const steps: { args: string[]; input?: string }[] = [{ args: ["type", "--clearmodifiers", "--delay", "12", "--file", "-"], input: a.text }];
      if (a.enter) steps.push({ args: ["key", "--clearmodifiers", "Return"] });
      return steps;
    }
    case "key":
      return [{ args: ["key", "--clearmodifiers", "--delay", "40", ...a.keys] }];
    case "scroll":
      return [
        {
          args: [
            ...(a.x !== undefined && a.y !== undefined ? ["mousemove", "--sync", String(a.x), String(a.y)] : []),
            "click",
            "--repeat",
            String(a.amount),
            "--delay",
            "40",
            SCROLL[a.direction]!,
          ],
        },
      ];
    case "wait":
      return [];
  }
}

const q = (s: string, n = 80) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);

/** Human text for cards, labels, traces and audit. Secret text is never included. */
export function describeAction(a: DesktopAction): string {
  switch (a.kind) {
    case "click":
      return `${a.double ? "double-click" : a.button === "left" ? "click" : `${a.button}-click`} at (${a.x}, ${a.y})`;
    case "type":
      return `type ${a.secret ? `[secret, ${a.text.length} chars — hidden]` : q(a.text)}${a.enter ? " + Enter" : ""}`;
    case "key":
      return `press ${a.keys.join(" ")}`;
    case "scroll":
      return `scroll ${a.direction} ×${a.amount}${a.x !== undefined ? ` at (${a.x}, ${a.y})` : ""}`;
    case "wait":
      return `wait ${a.ms} ms`;
  }
}

/** Click/scroll target for the card's marker. */
export function actionMark(a: DesktopAction): { x: number; y: number } | undefined {
  if (a.kind === "click") return { x: a.x, y: a.y };
  if (a.kind === "scroll" && a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y };
  return undefined;
}

/** Best-effort redaction for anything that might echo raw args (e.g. a failed-parse audit line). */
export function redactText(s: string, secrets: string[]): string {
  let out = s;
  for (const t of secrets) if (t && t.length >= 1) out = out.split(t).join("[secret]");
  return out;
}
