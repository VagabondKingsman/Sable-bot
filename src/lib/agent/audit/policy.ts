/**
 * Who may decide an approval. Only human surfaces: the owner in the web UI
 * (kind user) or the owner on an allow-listed channel (kind channel). A
 * routine / trigger / agent / subagent can never approve anything — not its
 * own ask, not another's. A channel peer that is an app (webhook) may not
 * approve an ask its own message started (self-approval).
 */
import { BACKGROUND_KINDS, type Initiator } from "./types.ts";

export type Decision = { ok: true } | { ok: false; reason: string };

/** W3 (D2): desktop actions are approved only by the owner in the web UI (who sees the screenshot). */
export const isDesktopTool = (tool?: string | null) => Boolean(tool && /^desktop[_.]/.test(tool));

export function canDecide(decider: Initiator, askInitiator: Initiator | null, tool?: string | null): Decision {
  if (BACKGROUND_KINDS.includes(decider.kind))
    return { ok: false, reason: `${decider.kind} initiators can never approve (no auto-approve in the background)` };
  if (isDesktopTool(tool)) {
    if (askInitiator && chainHasBackground(askInitiator))
      return { ok: false, reason: "desktop actions started by a background initiator can never be approved" };
    if (decider.kind !== "user") return { ok: false, reason: "desktop actions can only be approved by the owner in the Sable web UI" };
    return { ok: true };
  }
  if (decider.kind === "user") return { ok: true };
  if (decider.kind === "channel") {
    if (!/^(telegram|webhook):/.test(decider.id)) return { ok: false, reason: "unknown channel" };
    if (decider.id.startsWith("webhook:") && askInitiator && sameChain(askInitiator, decider))
      return { ok: false, reason: "self-approval: this webhook peer started the run that asks" };
    return { ok: true };
  }
  return { ok: false, reason: "unknown decider" };
}

function chainHasBackground(a: Initiator): boolean {
  if (BACKGROUND_KINDS.includes(a.kind)) return true;
  return a.via ? chainHasBackground(a.via) : false;
}

function sameChain(a: Initiator, d: Initiator): boolean {
  if (a.kind === d.kind && a.id === d.id) return true;
  return a.via ? sameChain(a.via, d) : false;
}
