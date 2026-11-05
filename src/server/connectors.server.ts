/** W2b: connector runtime (sync into triage, agent tools). Filled in by the Gmail / Calendar items. */
import { OAuthError } from "@/lib/agent/oauth/types";

export async function syncConnector(id: string): Promise<{ synced: number }> {
  throw new OAuthError("unsupported", `Connector ${id} chưa hỗ trợ đồng bộ.`);
}
