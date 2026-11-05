/**
 * The desk (threads + presets) on disk: one JSON file in the data dir,
 * written atomically with mode 0600. Single process; the in-memory doc is the
 * truth between writes. SABLE_DESK_SYNC=0 turns the server copy off (each
 * browser keeps its own localStorage copy, as before Phase 4).
 */
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { applyPush, changesSince, emptyDoc, exportDoc, importFile, parseDoc, type DeskDoc, type DeskPush } from "@/lib/agent/desk/sync";
import { dataDir } from "./paths";

export const deskSyncEnabled = () => process.env.SABLE_DESK_SYNC !== "0";

type Holder = { file: string; doc: DeskDoc };
const g = globalThis as unknown as { __sableDesk?: Holder };

function holder(): Holder {
  const file = path.join(dataDir(), "desk.json");
  if (g.__sableDesk?.file === file) return g.__sableDesk;
  let doc = emptyDoc();
  try {
    if (fs.existsSync(file)) doc = parseDoc(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
  }
  g.__sableDesk = { file, doc };
  return g.__sableDesk;
}

function save(h: Holder) {
  fs.mkdirSync(path.dirname(h.file), { recursive: true, mode: 0o700 });
  writeAtomic(h.file, JSON.stringify(h.doc));
}

export function deskChanges(since: number) {
  return changesSince(holder().doc, since);
}

export function deskSync(since: number, push: DeskPush) {
  const h = holder();
  const result = applyPush(h.doc, push);
  if (result.changed) save(h);
  return { ...result, ...changesSince(h.doc, since) };
}

export function deskExport() {
  return exportDoc(holder().doc);
}

export function deskImport(raw: unknown) {
  const h = holder();
  const result = importFile(h.doc, raw);
  if (result?.changed) save(h);
  return result;
}

/** Test helper. */
export function resetDeskCache() {
  g.__sableDesk = undefined;
}
