#!/usr/bin/env node
/**
 * W0 offline checks for router / scope / vault redact / field-journal.
 * Exit 1 on failure. Does not call LLMs or install tools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// Use strip-types via dynamic import of .ts through node --experimental-strip-types in npm script.
const { classify, loadRoutingConfig, routerOn } = await import("../src/lib/agent/router/match.ts");
const { assertReadyForAct } = await import("../src/lib/agent/scope/guard.ts");
const { ScopeStore, scopeKillDenyAll } = await import("../src/lib/agent/scope/store.ts");
const { redactVaultNames, VaultStore } = await import("../src/lib/agent/vault/store.ts");
const { MemoryStore } = await import("../src/lib/agent/memory/store.ts");
const { writeLesson, recallLessons } = await import("../src/lib/agent/field-journal/journal.ts");

let failed = 0;
function check(id, cond, detail = "") {
  if (cond) console.log(`PASS ${id}`);
  else {
    failed += 1;
    console.log(`FAIL ${id} ${detail}`);
  }
}

const cfg = loadRoutingConfig(path.join(root, "skills/routing.json"));
check("router-on", routerOn({}) === true);
check("router-off", routerOn({ SABLE_ROUTER: "0" }) === false);
check("route-R1", classify("please research this topic deeply", cfg).routeId === "R1");
check("route-R2", classify("code review my own files", cfg).routeId === "R2");
check("route-G0", classify("hello", cfg).routeId === "G0");
check(
  "no-re-routes",
  Object.values(cfg.routes).every((r) => !/apk|pentest|frida|exploit|jadx/i.test(r.skill + r.label)),
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w0-eval-"));
const store = new ScopeStore(dir);
const now = Date.now();
const pending = store.create({ target: "notes.md", purpose: "doc audit", owner: "He", now, ttlMs: 60_000 });
check("scope-pending", assertReadyForAct(store, { requiresScope: true, scopeId: pending.id, mode: "interactive", now }).ok === false);
store.decide(pending.id, "approved", "a1", now);
check("scope-approved", assertReadyForAct(store, { requiresScope: true, scopeId: pending.id, mode: "background", now: now + 10 }).ok === true);
check("scope-expired", assertReadyForAct(store, { requiresScope: true, scopeId: pending.id, mode: "interactive", now: now + 120_000 }).ok === false);
check("scope-kill", scopeKillDenyAll({ SABLE_SCOPE: "0" }) === true);
check(
  "scope-kill-act",
  assertReadyForAct(store, { requiresScope: true, scopeId: pending.id, mode: "interactive", env: { SABLE_SCOPE: "0" }, now }).ok === false,
);

const vdir = fs.mkdtempSync(path.join(os.tmpdir(), "w0-vault-"));
const vault = new VaultStore(vdir, { SABLE_VAULT_KEY: "eval-master-key-please-change" });
vault.put("DEMO_KEY", "secret-value-xyz");
check("vault-list-no-value", !JSON.stringify(vault.meta()).includes("secret-value"));
check("vault-redact", redactVaultNames("DEMO_KEY=secret-value-xyz", ["DEMO_KEY"]).includes("[đã ẩn]"));

const mdir = fs.mkdtempSync(path.join(os.tmpdir(), "w0-mem-"));
const mem = new MemoryStore(mdir);
const w = writeLesson(mem, { scenario: "coding", lesson: "run tests before commit in own repo" });
check("journal-write", w.ok === true);
check("journal-recall", recallLessons(mem, "coding tests").length >= 1);

console.log(failed ? `\n${failed} failed` : "\nall w0 eval checks passed");
process.exit(failed ? 1 : 0);
