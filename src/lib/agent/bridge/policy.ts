/** W6: who may start an outbound bridge handoff. Only the owner (user kind), never anything with background in its chain. */
import { BACKGROUND_KINDS, type Initiator } from "../audit/types.ts";

const chainHasBackground = (i: Initiator | undefined): boolean => !!i && (BACKGROUND_KINDS.includes(i.kind) || chainHasBackground(i.via));

export function mayStart(initiator: Initiator | undefined): string | null {
  if (!initiator) return "no initiator";
  if (chainHasBackground(initiator)) return "background initiators can never send over the bridge";
  if (initiator.kind !== "user") return `${initiator.kind} initiators cannot send over the bridge (owner in the web UI only)`;
  return null;
}
