import test from "node:test";
import assert from "node:assert/strict";
import { mediaImageTool, mediaToolOn, type MediaQuote } from "./tool.ts";

const ctx = { workspaceDir: "/tmp", signal: new AbortController().signal, mode: "agent" } as never;

function make(q: MediaQuote) {
  let calls = 0;
  const tool = mediaImageTool({
    quote: () => q,
    generate: async () => {
      calls += 1;
      return { ok: true, id: "img_1", model: "m" };
    },
    fileUrl: (id) => `/api/media/file/${id}`,
  });
  return { tool, calls: () => calls };
}

test("media_image is a write tool needing approval with cost on the card", () => {
  const { tool } = make({ usd: 0.07, spentUsd: 1, capUsd: 5, budgetOk: true });
  assert.equal(tool.needsApproval, true);
  assert.equal(tool.risk, "write");
  const card = tool.describe!({ prompt: "a cat", aspect: "16:9" });
  assert.match(card.summary, /\$0\.07/);
  assert.match(card.summary, /\$5\.00/);
  assert.equal(card.preview, "a cat");
});

test("over cap refuses in check and run without generating", async () => {
  const { tool, calls } = make({ usd: 0.07, spentUsd: 4.99, capUsd: 5, budgetOk: true });
  assert.match((await tool.check!({ prompt: "x" }, ctx))!, /trần/);
  const r = await tool.run({ prompt: "x" }, ctx);
  assert.equal(r.ok, false);
  assert.equal(calls(), 0);
  const b = make({ usd: 0.07, spentUsd: 0, capUsd: null, budgetOk: false, reason: "budget" });
  assert.equal(await b.tool.check!({ prompt: "x" }, ctx), "budget");
});

test("run returns markdown image link; kill switches", async () => {
  const { tool, calls } = make({ usd: 0.07, spentUsd: 0, capUsd: null, budgetOk: true });
  assert.equal(await tool.check!({ prompt: "" }, ctx), "Thiếu prompt.");
  const r = await tool.run({ prompt: "a cat", aspect: "bogus" }, ctx);
  assert.equal(r.ok, true);
  assert.match(r.output, /!\[ảnh\]\(\/api\/media\/file\/img_1\)/);
  assert.equal(calls(), 1);
  assert.equal(mediaToolOn({ SABLE_MEDIA_TOOL: "0" } as never), false);
  assert.equal(mediaToolOn({ SABLE_MEDIA: "0" } as never), false);
  assert.equal(mediaToolOn({} as never), true);
});
