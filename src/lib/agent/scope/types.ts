/** Owner-approved authorization scope before ACT against a declared target. */
export type ScopeStatus = "pending" | "approved" | "denied" | "expired";

export type ScopeRecord = {
  id: string;
  /** Declared target (path, host, or label). */
  target: string;
  purpose: string;
  owner: string;
  /** Epoch ms. */
  createdAt: number;
  expiresAt: number;
  status: ScopeStatus;
  /** Approval card id when approved/denied via UI. */
  approvalId?: string;
  decidedAt?: number;
  networkProfile?: "offline" | "lab_only" | "authorized_target_only";
  notes?: string;
};

export type ScopeDecision = { ok: true; scope: ScopeRecord } | { ok: false; reason: string; scope?: ScopeRecord };
