import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_PROFILES,
  defaultState,
  deleteProfile,
  mergeState,
  profilesOn,
  setActive,
  spawnToolsFor,
  upsertProfile,
  applyProfileTools,
} from "./profiles.ts";

test("profiles: builtins + kill switch", () => {
  assert.equal(profilesOn({ SABLE_PROFILES: "0" }), false);
  assert.ok(BUILTIN_PROFILES.some((p) => p.id === "sable"));
  const s = defaultState();
  assert.equal(s.activeId, "sable");
  assert.ok(s.profiles.length >= 4);
});

test("profiles: upsert custom, activate, delete; cannot delete builtin", () => {
  let state = defaultState();
  const up = upsertProfile(state, {
    id: "legal",
    name: "Legal",
    instructions: "Be precise and cite sources.",
    tools: { files: true, web: true },
    spawnTools: ["fs_read", "http_fetch"],
  });
  assert.equal(up.ok, true);
  if (!up.ok) return;
  state = up.state;
  assert.ok(state.profiles.some((p) => p.id === "legal"));
  const act = setActive(state, "legal");
  assert.equal(act.ok, true);
  if (act.ok) state = act.state;
  assert.equal(state.activeId, "legal");
  const bad = deleteProfile(state, "sable");
  assert.equal(bad.ok, false);
  const del = deleteProfile(state, "legal");
  assert.equal(del.ok, true);
  if (del.ok) {
    assert.equal(del.state.activeId, "sable");
    assert.equal(del.state.profiles.some((p) => p.id === "legal"), false);
  }
});

test("profiles: mergeState recovers customs and spawnToolsFor", () => {
  const merged = mergeState({
    activeId: "legal",
    profiles: [
      { id: "legal", name: "Legal", instructions: "cite", tools: { web: true }, spawnTools: ["http_fetch"], updatedAt: 1 },
      { id: "BAD ID", name: "x", instructions: "y" },
    ],
  });
  assert.ok(merged.profiles.some((p) => p.id === "legal"));
  assert.equal(merged.activeId, "legal");
  const spec = spawnToolsFor(merged, "legal");
  assert.deepEqual(spec?.tools, ["http_fetch"]);
  assert.equal(spawnToolsFor(merged, "nope"), null);
  const research = spawnToolsFor(merged, "research");
  assert.ok(research?.tools.includes("http_fetch"));
});

test("profiles: applyProfileTools merges flags", () => {
  const out = applyProfileTools(
    { web: false, x: false, code: false, image: false, files: true, fetch: true },
    { id: "r", name: "r", instructions: "i", tools: { web: true, files: false }, spawnTools: [], updatedAt: 0 },
  );
  assert.equal(out.web, true);
  assert.equal(out.files, false);
  assert.equal(out.fetch, true);
});
