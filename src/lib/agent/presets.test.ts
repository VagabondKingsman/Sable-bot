import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPreset,
  bindPresetToModel,
  DEFAULT_PRESET_ID,
  deletePreset,
  isDirty,
  migratePresets,
  MIGRATED_PRESET_NAME,
  modelsBoundTo,
  presetForModel,
  savePreset,
  type PresetState,
} from "./presets.ts";
import { DEFAULT_INSTRUCTIONS } from "./types.ts";

let counter = 0;
const ids = () => `p${++counter}`;

function base(): PresetState {
  const { instructions: _ignored, ...state } = migratePresets(undefined, DEFAULT_INSTRUCTIONS, 1, ids);
  return state;
}

test("first run seeds the default preset and keeps it active", () => {
  const state = migratePresets(undefined, DEFAULT_INSTRUCTIONS, 1, ids);
  assert.equal(state.presets.length, 1);
  assert.equal(state.presets[0].id, DEFAULT_PRESET_ID);
  assert.equal(state.presets[0].name, "Sable mặc định");
  assert.equal(state.activePresetId, DEFAULT_PRESET_ID);
  assert.equal(state.instructions, DEFAULT_INSTRUCTIONS);
});

test("migration preserves custom instructions as their own preset", () => {
  const state = migratePresets(undefined, "Trả lời ngắn gọn bằng tiếng Việt.", 5, () => "mine");
  assert.equal(state.instructions, "Trả lời ngắn gọn bằng tiếng Việt.");
  assert.deepEqual(
    state.presets.map((preset) => [preset.id, preset.name]),
    [
      [DEFAULT_PRESET_ID, "Sable mặc định"],
      ["mine", MIGRATED_PRESET_NAME],
    ],
  );
  assert.equal(state.activePresetId, "mine");
  assert.equal(isDirty(state, state.instructions), false);
});

test("migration resets stale instructions and drops stale or broken presets", () => {
  const state = migratePresets(
    {
      presets: [
        { id: "old", name: "x", body: "Bạn là Sable, builder cũ", updatedAt: 1 },
        { id: "ok", name: "  Viết   code ", body: "Chỉ viết code.", updatedAt: 2 },
        { id: "", name: "bad", body: "y", updatedAt: 1 },
        { id: DEFAULT_PRESET_ID, name: "Hacked", body: "khác", updatedAt: 1 },
      ],
      activePresetId: "old",
      modelBindings: { "grok-4.7": "ok", "deepseek-chat": "old" },
    },
    "Bạn là Sable, trợ lý riêng xưa",
    9,
    ids,
  );
  assert.equal(state.instructions, DEFAULT_INSTRUCTIONS);
  assert.deepEqual(
    state.presets.map((preset) => preset.id),
    [DEFAULT_PRESET_ID, "ok"],
  );
  assert.equal(state.presets[0].body, DEFAULT_INSTRUCTIONS, "default preset always tracks the shipped prompt");
  assert.equal(state.presets[1].name, "Viết code");
  assert.equal(state.activePresetId, null);
  assert.deepEqual(state.modelBindings, { "grok-4.7": "ok" });
});

test("apply loads the body and marks it active", () => {
  const saved = savePreset(base(), { name: "Dịch", body: "Dịch sang tiếng Anh." }, 2, () => "tr");
  const applied = applyPreset(saved.state, DEFAULT_INSTRUCTIONS, "tr");
  assert.deepEqual(applied, { activePresetId: "tr", instructions: "Dịch sang tiếng Anh." });
  assert.deepEqual(applyPreset(saved.state, "giữ nguyên", "missing"), {
    activePresetId: saved.state.activePresetId,
    instructions: "giữ nguyên",
  });
});

test("save updates custom presets but never overwrites the default", () => {
  let state = base();
  const viaDefault = savePreset(state, { id: DEFAULT_PRESET_ID, name: "x", body: "sửa default" }, 3, () => "fork");
  assert.equal(viaDefault.id, "fork");
  assert.equal(viaDefault.state.presets[0].body, DEFAULT_INSTRUCTIONS);
  state = viaDefault.state;
  const updated = savePreset(state, { id: "fork", name: "Bản sửa", body: "nội dung mới" }, 4);
  assert.equal(updated.id, "fork");
  assert.equal(updated.state.presets.length, 2);
  assert.equal(updated.state.presets[1].body, "nội dung mới");
  assert.equal(updated.state.presets[1].updatedAt, 4);
  assert.equal(isDirty(updated.state, "nội dung mới"), false);
  assert.equal(isDirty(updated.state, "nội dung mới!"), true);
});

test("bindings load on model switch and leave unbound models alone", () => {
  let state = savePreset(base(), { name: "Code", body: "Chỉ viết code." }, 2, () => "code").state;
  state = bindPresetToModel(state, "deepseek-chat", "code");
  state = bindPresetToModel(state, "grok-4.7", DEFAULT_PRESET_ID);
  state = bindPresetToModel(state, "gpt-x", "missing");
  assert.deepEqual(state.modelBindings, { "deepseek-chat": "code", "grok-4.7": DEFAULT_PRESET_ID });
  assert.deepEqual(modelsBoundTo(state, "code"), ["deepseek-chat"]);

  state = { ...state, activePresetId: DEFAULT_PRESET_ID };
  assert.deepEqual(presetForModel(state, DEFAULT_INSTRUCTIONS, "deepseek-chat"), {
    activePresetId: "code",
    instructions: "Chỉ viết code.",
  });
  assert.equal(presetForModel(state, "bất kỳ", "unbound-model"), null);
  assert.equal(presetForModel(state, DEFAULT_INSTRUCTIONS, "grok-4.7"), null, "already loaded");

  state = bindPresetToModel(state, "deepseek-chat", null);
  assert.deepEqual(state.modelBindings, { "grok-4.7": DEFAULT_PRESET_ID });
});

test("delete removes custom presets and their bindings, never the default", () => {
  let state = savePreset(base(), { name: "Tạm", body: "tạm" }, 2, () => "tmp").state;
  state = bindPresetToModel(state, "deepseek-chat", "tmp");
  assert.equal(deletePreset(state, DEFAULT_PRESET_ID), state);
  const next = deletePreset(state, "tmp");
  assert.deepEqual(
    next.presets.map((preset) => preset.id),
    [DEFAULT_PRESET_ID],
  );
  assert.deepEqual(next.modelBindings, {});
  assert.equal(next.activePresetId, null);
});
