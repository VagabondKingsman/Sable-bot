import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramChannel, type TgUpdate } from "./channels/telegram.ts";
import { withReference, decorateReplies, steerText, REF_MAX } from "./turns/reply.ts";

const TOKEN = "123456:" + "T".repeat(35);
const OWNER = 111;
const OWNER2 = 222;

function fakeApi(updates: TgUpdate[][]) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === "getUpdates") return Response.json({ ok: true, result: updates.shift() ?? [] });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 50, date: 0, chat: { id: body.chat_id, type: "private" } } });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const m = (id: number, from: number, text: string, extra: Record<string, unknown> = {}): TgUpdate => ({
  update_id: id,
  message: { message_id: id, date: 1_000, chat: { id: from, type: "private" }, from: { id: from }, text, ...extra },
});

test("telegram W7: polling never blocks on a slow turn; per-chat order kept, other chats proceed", async () => {
  const { fetchImpl } = fakeApi([[m(1, OWNER, "slow"), m(2, OWNER, "second"), m(3, OWNER2, "other")]]);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tg = new TelegramChannel({
    token: TOKEN,
    base: "http://mock",
    owners: new Set([OWNER, OWNER2]),
    fetch: fetchImpl,
    now: () => 1_000_000,
    onMessage: async (x) => {
      order.push(`start:${x.text}`);
      if (x.text === "slow") await gate;
      order.push(`end:${x.text}`);
    },
    onCallback: () => "",
  });
  const t0 = Date.now();
  assert.equal(await tg.pollOnce(), 3);
  assert.ok(Date.now() - t0 < 500, "pollOnce returned while a turn is still running");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["start:slow", "start:other", "end:other"], "chat 2 not blocked; chat 1 second message waits");
  release();
  await tg.idle();
  assert.deepEqual(order.slice(3), ["end:slow", "start:second", "end:second"]);
});

test("telegram W7: reply_to_message → replyTo; send(replyTo) → reply_parameters; owner-only sends", async () => {
  const { calls, fetchImpl } = fakeApi([[m(7, OWNER, "về cái này", { reply_to_message: { message_id: 5, date: 900, chat: { id: OWNER, type: "private" }, from: { id: 99, is_bot: true }, text: "Kết quả cũ của Sable" } })]]);
  const got: unknown[] = [];
  const tg = new TelegramChannel({ token: TOKEN, base: "http://mock", owners: new Set([OWNER]), fetch: fetchImpl, now: () => 1_000_000, onMessage: (x) => void got.push(x), onCallback: () => "" });
  await tg.pollOnce();
  await tg.idle();
  assert.deepEqual((got[0] as { replyTo: unknown }).replyTo, { messageId: 5, text: "Kết quả cũ của Sable", fromBot: true });
  await tg.send(OWNER, "trả lời", undefined, 7);
  const sent = calls.find((c) => c.method === "sendMessage")!;
  assert.deepEqual(sent.body.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
  await tg.send(OWNER, "no reply");
  assert.equal(calls.filter((c) => c.method === "sendMessage")[1].body.reply_parameters, undefined);
  await assert.rejects(tg.send(999, "x", undefined, 7), /owner allowlist/);
});

test("reply/quote: referenced message is inlined, truncated and marked; steer text marked", () => {
  const long = "a".repeat(2_000);
  const out = withReference("new question", { role: "assistant", excerpt: long });
  assert.match(out, /^\[Referenced message — your earlier reply, quoted \(may be truncated\): "a+…"\]\n\nnew question$/);
  assert.ok(out.length < REF_MAX + 120);
  assert.equal(withReference("plain", null), "plain");
  const d = decorateReplies([{ role: "user", content: "x", replyTo: { role: "user", excerpt: "earlier" } }, { role: "assistant", content: "y" }]) as { content: string }[];
  assert.match(d[0].content, /an earlier message from the owner/);
  assert.equal(d[1].content, "y");
  assert.match(steerText("also"), /^\[New message from the owner while you were working/);
});
