import assert from "node:assert/strict";
import test from "node:test";
import { BENIGN_TOOLS } from "./manifest.ts";
import { detectOs, proposeInstalls, scanTools, toolIndexOn } from "./scan.ts";

test("toolIndex kill switch + no RE binaries in manifest", () => {
  assert.equal(toolIndexOn({}), true);
  assert.equal(toolIndexOn({ SABLE_TOOLINDEX: "0" }), false);
  for (const t of BENIGN_TOOLS) {
    assert.ok(!/jadx|frida|nmap|sqlmap|metasploit|apktool|ghidra|radare/i.test(t.id + t.binary));
  }
});

test("scan PATH: git/node likely present; propose only missing", () => {
  const rows = scanTools();
  assert.ok(rows.length >= 5);
  const git = rows.find((r) => r.id === "git");
  assert.ok(git);
  // On this box git exists — available true; if somehow missing, must have install cmd.
  if (!git!.available) assert.ok(git!.installCommand?.includes("git"));
  const proposals = proposeInstalls(rows);
  for (const p of proposals) {
    assert.ok(p.command.length > 3);
    assert.ok(!/curl\s+.*\|\s*(ba)?sh/i.test(p.command), "no pipe-to-shell installers");
  }
  assert.ok(["debian", "macos", "unknown"].includes(detectOs()));
});
