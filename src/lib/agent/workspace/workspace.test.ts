import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { taskWorkspacePath } from "./paths.ts";
import { WorkspaceStore } from "./store.ts";

test("workspace: 3 parallel tasks no cross-talk; wipe; kill switch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sable-ws-"));
  const env = { SABLE_TASK_WORKSPACE_ROOT: root, SABLE_WORKSPACES: "1" };
  const store = new WorkspaceStore("/tmp/fallback-unused", env);
  const ids = ["task_a", "task_b", "task_c"];
  for (const id of ids) {
    const info = store.ensure(id);
    fs.writeFileSync(path.join(info.root, "out", `${id}.txt`), `hello-${id}`);
  }
  for (const id of ids) {
    const p = path.join(taskWorkspacePath(id, env), "out", `${id}.txt`);
    assert.equal(fs.readFileSync(p, "utf8"), `hello-${id}`);
    // No other task files inside
    const others = fs.readdirSync(path.join(taskWorkspacePath(id, env), "out"));
    assert.deepEqual(others, [`${id}.txt`]);
  }
  assert.equal(store.wipe("task_b"), true);
  assert.equal(fs.existsSync(taskWorkspacePath("task_b", env)), false);
  assert.equal(fs.existsSync(taskWorkspacePath("task_a", env)), true);

  const off = new WorkspaceStore("/tmp/shared-fallback-ws", { ...env, SABLE_WORKSPACES: "0" });
  assert.equal(off.resolve("task_a"), path.resolve("/tmp/shared-fallback-ws"));
});

test("workspace: refuse wipe outside tasks root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sable-ws-"));
  const store = new WorkspaceStore("/tmp/x", { SABLE_TASK_WORKSPACE_ROOT: root });
  // Crafted id that would try escape is rejected by assertTaskId
  assert.throws(() => store.wipe("../etc"));
});
