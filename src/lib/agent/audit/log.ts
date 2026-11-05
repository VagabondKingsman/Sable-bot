/** Append-only audit.jsonl (0600), capped by rotation to the newest lines. */
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "../memory/redact.ts";
import type { AuditRecord, AuditType, Initiator, InitiatorKind } from "./types.ts";

const MAX_LINES = 5_000;
const KEEP_LINES = 4_000;

export type AuditInput = Omit<AuditRecord, "id" | "at" | "initiator_kind" | "initiator_id" | "via_kind" | "via_id" | "decider_kind" | "decider_id"> & {
  initiator: Initiator;
  decider?: Initiator;
  at?: number;
};

export class AuditLog {
  readonly file: string;
  private lines = -1;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.file = path.join(dir, "audit.jsonl");
  }

  record(input: AuditInput): AuditRecord {
    const { initiator, decider, at, ...rest } = input;
    const root = initiator.via;
    const rec: AuditRecord = {
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: at ?? Date.now(),
      ...rest,
      initiator_kind: initiator.kind,
      initiator_id: initiator.id.slice(0, 160),
      ...(root ? { via_kind: root.kind, via_id: root.id.slice(0, 160) } : {}),
      ...(decider ? { decider_kind: decider.kind, decider_id: decider.id.slice(0, 160) } : {}),
    };
    if (rec.summary) rec.summary = redactSecrets(rec.summary.slice(0, 300)).text;
    if (rec.reason) rec.reason = redactSecrets(rec.reason.slice(0, 300)).text;
    const fd = fs.openSync(this.file, "a", 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
    if (this.lines < 0) this.lines = this.readAll().length;
    else this.lines++;
    if (this.lines > MAX_LINES) this.rotate();
    return rec;
  }

  private readAll(): AuditRecord[] {
    try {
      return fs
        .readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as AuditRecord];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private rotate() {
    const keep = this.readAll().slice(-KEEP_LINES);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.lines = keep.length;
  }

  list(q: { type?: AuditType; kind?: InitiatorKind; jobId?: string; approvalId?: string; since?: number; limit?: number } = {}): AuditRecord[] {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1_000);
    return this.readAll()
      .filter((r) => (!q.type || r.type === q.type) && (!q.kind || r.initiator_kind === q.kind) && (!q.jobId || r.jobId === q.jobId) && (!q.approvalId || r.approvalId === q.approvalId) && (!q.since || r.at >= q.since))
      .reverse()
      .slice(0, limit);
  }
}
