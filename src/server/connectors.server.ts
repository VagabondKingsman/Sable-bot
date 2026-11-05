/**
 * W2b connector runtime: API clients bound to the OAuth manager, agent tools
 * for connected connectors, and the Gmail → triage pull (10-min ticker +
 * manual "Đồng bộ thư").
 */
import { OAuthError } from "@/lib/agent/oauth/types";
import { GOOGLE_BASES } from "@/lib/agent/connectors/google";
import { gmailClient, type GmailClient } from "@/lib/agent/connectors/gmail";
import { gmailTools, mailToTriage } from "@/lib/agent/connectors/gmail-tools";
import type { ApiCall } from "@/lib/agent/connectors/http";
import type { FunctionTool } from "@/lib/agent/tools/types";
import { oauthManager, oauthOn } from "@/server/oauth.server";

const apiFor = (id: string): ApiCall => (url, init) => oauthManager().request(id, url, init);

export function gmailFor(): GmailClient | null {
  return oauthOn() && oauthManager().hasToken("gmail") ? gmailClient(GOOGLE_BASES.gmail, apiFor("gmail")) : null;
}

/**
 * Tools for connected connectors. Routine/trigger runs never get tools that need
 * approval (same rule as MCP); gmail_send also refuses background initiators itself.
 */
export function connectorToolsFor(source: string): FunctionTool[] {
  if (!oauthOn()) return [];
  const out: FunctionTool[] = [];
  if (oauthManager().hasToken("gmail")) out.push(...gmailTools(gmailFor));
  return source === "routine" ? out.filter((t) => !t.needsApproval) : out;
}

export async function syncGmail(): Promise<{ synced: number }> {
  const g = gmailFor();
  if (!g) throw new OAuthError("needs_auth", "Gmail chưa kết nối.");
  const { recordIncoming } = await import("@/server/proactive.server");
  const mails = await g.recent();
  for (const m of mails) recordIncoming(mailToTriage(m));
  oauthManager().markSynced("gmail");
  return { synced: mails.length };
}

export async function syncConnector(id: string): Promise<{ synced: number }> {
  if (id === "gmail") return syncGmail();
  throw new OAuthError("unsupported", `Connector ${id} không cần đồng bộ (đọc trực tiếp khi dùng).`);
}

const TICK = Symbol.for("sable.connectors.gmailTicker");

/** Pull new mail into triage every 10 minutes while Gmail is connected. */
export function startConnectorTicker(intervalMs = 10 * 60_000) {
  const g = globalThis as typeof globalThis & { [TICK]?: ReturnType<typeof setInterval> };
  if (g[TICK]) return;
  let busy = false;
  g[TICK] = setInterval(() => {
    if (busy || !gmailFor()) return;
    busy = true;
    void syncGmail()
      .catch((error) => console.warn(`[sable-connectors] gmail sync failed: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  g[TICK].unref?.();
}
