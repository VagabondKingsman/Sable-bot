import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { open, seal, resolveMasterKey, vaultOn } from "./crypto.ts";
import { redactVaultNames, VaultStore } from "./store.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-vault-"));
}

test("vault crypto round-trip + kill switch", () => {
  assert.equal(vaultOn({}), true);
  assert.equal(vaultOn({ SABLE_VAULT: "0" }), false);
  const key = resolveMasterKey({ SABLE_VAULT_KEY: "test-master-passphrase-for-sable" });
  assert.ok(key);
  const sealed = seal("super-secret-value", key!);
  assert.equal(open(sealed, key!), "super-secret-value");
});

test("VaultStore: put/list/get/remove; list never has values; kill switch", () => {
  const dir = tmp();
  const env = { SABLE_VAULT_KEY: "test-master-passphrase-for-sable" };
  const store = new VaultStore(dir, env);
  assert.deepEqual(store.list(), []);
  const fixtureVal = "fixture-value-not-a-live-credential";
  assert.equal(store.put("DEMO_SECRET", fixtureVal).ok, true);
  assert.deepEqual(store.list(), ["DEMO_SECRET"]);
  const meta = JSON.stringify(store.meta());
  assert.ok(!meta.includes(fixtureVal));
  assert.equal(store.get("DEMO_SECRET"), fixtureVal);
  assert.equal(store.remove("DEMO_SECRET"), true);
  assert.equal(store.get("DEMO_SECRET"), null);
  const off = new VaultStore(dir, { ...env, SABLE_VAULT: "0" });
  assert.equal(off.put("FOO", "bar").ok, false);
  assert.equal(
    redactVaultNames("DEMO_SECRET=fixture-leak-here and ok", ["DEMO_SECRET"]),
    "DEMO_SECRET=[đã ẩn] and ok",
  );
});

test("VaultStore: refuses bad names", () => {
  const store = new VaultStore(tmp(), { SABLE_VAULT_KEY: "test-master-passphrase-for-sable" });
  assert.equal(store.put("lowercase", "x").ok, false);
  assert.equal(store.put("OK_NAME", "").ok, false);
});
