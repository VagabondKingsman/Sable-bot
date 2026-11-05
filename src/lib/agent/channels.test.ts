import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramChannel, isOwner, parseOwners, clipText, type TgUpdate } from "./channels/telegram.ts";
import { SmtpChannel, smtpConfigFrom, cleanMail } from "./channels/smtp.ts";

const TOKEN = "123456:" + "T".repeat(35);
const OWNER = 111;

function fakeApi(updates: TgUpdate[][]) {
  const calls: { method: string; body: Record<string, unknown>; url: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init.body));
    calls.push({ method, body, url: String(url) });
    if (method === "getUpdates") return Response.json({ ok: true, result: updates.shift() ?? [] });
    if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: 9, date: 0, chat: { id: body.chat_id, type: "private" } } });
    return Response.json({ ok: true, result: true });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const msg = (id: number, from: number, text: string, chatType = "private", chatId = from, date = 1_000): TgUpdate => ({
  update_id: id,
  message: { message_id: id, date, chat: { id: chatId, type: chatType }, from: { id: from }, text },
});

test("telegram: owner allowlist — private chat with the owner only", () => {
  const owners = parseOwners("111, abc 222;333");
  assert.deepEqual([...owners], [111, 222, 333]);
  assert.equal(isOwner(owners, { id: 111, type: "private" }, { id: 111 }), true);
  assert.equal(isOwner(owners, { id: -5, type: "group" }, { id: 111 }), false);
  assert.equal(isOwner(owners, { id: 999, type: "private" }, { id: 999 }), false);
  assert.equal(isOwner(owners, { id: 111, type: "private" }, { id: 111, is_bot: true }), false);
  assert.equal(parseOwners(undefined).size, 0);
});

test("telegram: poll handles owner messages, drops strangers/groups/stale silently, offset advances", async () => {
  const { calls, fetchImpl } = fakeApi([
    [msg(1, OWNER, "hello"), msg(2, 999, "spam"), msg(3, OWNER, "in group", "group", -100), msg(4, OWNER, "old", "private", OWNER, 1), msg(1, OWNER, "dup")],
  ]);
  const got: string[] = [];
  let saved = 0;
  const tg = new TelegramChannel({
    token: TOKEN,
    base: "http://mock",
    owners: new Set([OWNER]),
    fetch: fetchImpl,
    now: () => 1_000_000,
    saveOffset: (offset) => (saved = offset),
    onMessage: (m) => void got.push(m.text),
    onCallback: () => "",
  });
  assert.equal(await tg.pollOnce(), 5);
  assert.deepEqual(got, ["hello"]);
  assert.equal(tg.dropped, 3);
  assert.equal(saved, 4);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0, "no replies to strangers");
  await tg.pollOnce();
  assert.equal(calls.at(-1)!.body.offset, 5);
});

test("telegram: callback buttons only from the owner, always answered", async () => {
  const { calls, fetchImpl } = fakeApi([
    [
      { update_id: 1, callback_query: { id: "c1", from: { id: OWNER }, data: "a:xyz", message: { message_id: 9, date: 0, chat: { id: OWNER, type: "private" } } } },
      { update_id: 2, callback_query: { id: "c2", from: { id: 999 }, data: "a:xyz", message: { message_id: 9, date: 0, chat: { id: 999, type: "private" } } } },
    ],
  ]);
  const decided: string[] = [];
  const tg = new TelegramChannel({ token: TOKEN, base: "http://mock", owners: new Set([OWNER]), fetch: fetchImpl, onMessage: () => {}, onCallback: (cb) => (decided.push(cb.data), "Đã duyệt") });
  await tg.pollOnce();
  assert.deepEqual(decided, ["a:xyz"]);
  const answers = calls.filter((c) => c.method === "answerCallbackQuery");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].body.text, "Đã duyệt");
});

test("telegram: never sends outside the allowlist; text redacted and clipped; token scrubbed from errors", async () => {
  const fetchImpl = (async () => {
    throw new Error(`connect failed for http://mock/bot${TOKEN}/sendMessage`);
  }) as unknown as typeof fetch;
  const lines: string[] = [];
  const tg = new TelegramChannel({ token: TOKEN, base: "http://mock", owners: new Set([OWNER]), fetch: fetchImpl, onMessage: () => {}, onCallback: () => "", log: (l) => lines.push(l) });
  await assert.rejects(tg.send(999, "hi"), /allowlist/);
  await assert.rejects(tg.send(OWNER, "hi"), (error: Error) => !error.message.includes(TOKEN) && error.message.includes("[token]"));
  assert.ok(clipText("x".repeat(5000)).length <= 3900);
  assert.ok(!clipText("key xai-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4").includes("A1b2C3d4E5f6"));
});

test("telegram: start/stop loop and 401 stops polling", async () => {
  let n = 0;
  const fetchImpl = (async () => (n++, Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }))) as unknown as typeof fetch;
  const tg = new TelegramChannel({ token: TOKEN, base: "http://mock", owners: new Set([OWNER]), fetch: fetchImpl, onMessage: () => {}, onCallback: () => "" });
  tg.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tg.running(), false);
  assert.equal(n, 1);
  assert.ok(!tg.lastError.includes(TOKEN));
});

test("smtp: config needs exactly one owner address; mail goes only there, redacted", async () => {
  assert.equal(smtpConfigFrom({}).config, null);
  assert.ok(smtpConfigFrom({ SABLE_SMTP_HOST: "h", SABLE_SMTP_TO: "a@x.io, b@y.io", SABLE_SMTP_FROM: "s@x.io" }).error);
  const { config } = smtpConfigFrom({ SABLE_SMTP_HOST: "127.0.0.1", SABLE_SMTP_PORT: "2525", SABLE_SMTP_TO: "me@x.io", SABLE_SMTP_FROM: "sable@x.io", SABLE_SMTP_ALLOW_INSECURE: "1" });
  assert.ok(config && config.port === 2525 && !config.secure && config.allowInsecure);
  const sent: Record<string, unknown>[] = [];
  const smtp = new SmtpChannel(config!, async () => ({ sendMail: async (m) => void sent.push(m) }));
  assert.equal(await smtp.notify({ subject: "Hi\r\nBcc: evil@x.io", text: "password: hunter22x" }), true);
  assert.equal(sent[0].to, "me@x.io");
  assert.ok(!String(sent[0].subject).includes("\n"));
  assert.ok(!String(sent[0].text).includes("hunter22x"));
  assert.equal(cleanMail({ subject: "a", text: "b" }).text, "b");
  const failing = new SmtpChannel({ ...config!, pass: "s3cretpass" }, async () => ({ sendMail: async () => { throw new Error("auth failed s3cretpass"); } }));
  assert.equal(await failing.notify({ subject: "x", text: "y" }), false);
  assert.ok(!failing.lastError.includes("s3cretpass"));
});
