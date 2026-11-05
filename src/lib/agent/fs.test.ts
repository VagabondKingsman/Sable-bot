import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fsList, fsRead, fsWrite, jail } from "./tools/fs.ts";
import { checkUrl, createHttpFetch, hostAllowed, htmlToText, isPrivateIp, pinnedFetch } from "./tools/fetch.ts";
import http from "node:http";
import zlib from "node:zlib";
import { execute } from "./tools/execute.ts";
import type { ToolContext } from "./tools/types.ts";

async function sandbox() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "sable-jail-"));
  const root = path.join(base, "ws");
  const outside = path.join(base, "secret");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "key.txt"), "TOP SECRET");
  return { base, root, outside };
}

test("jail keeps paths inside the workspace", async () => {
  const { root } = await sandbox();
  const real = await fs.realpath(root);
  assert.equal(await jail(root, "a/b.txt"), path.join(real, "a/b.txt"));
  assert.equal(await jail(root, "/notes.md"), path.join(real, "notes.md"));
  assert.equal(await jail(root, ""), real);
  for (const bad of ["../secret/key.txt", "a/../../x", "../../etc/passwd", "a\0b"]) {
    await assert.rejects(() => jail(root, bad), /outside workspace|bad path/, bad);
  }
});

test("jail blocks symlink escapes (file and folder)", async () => {
  const { root, outside } = await sandbox();
  await fs.symlink(path.join(outside, "key.txt"), path.join(root, "link.txt"));
  await fs.symlink(outside, path.join(root, "dir"));
  await assert.rejects(() => jail(root, "link.txt"), /outside workspace/);
  await assert.rejects(() => jail(root, "dir/key.txt"), /outside workspace/);
  await assert.rejects(() => jail(root, "dir/new.txt"), /outside workspace/);
  const ctx: ToolContext = { workspaceDir: root, signal: new AbortController().signal, mode: "interactive", approve: async () => true };
  const read = await execute(fsRead, '{"path":"link.txt"}', ctx);
  assert.equal(read.ok, false);
  assert.ok(!read.output.includes("TOP SECRET"));
  const write = await execute(fsWrite, '{"path":"dir/pwn.txt","content":"x"}', ctx);
  assert.equal(write.ok, false);
  await assert.rejects(() => fs.stat(path.join(outside, "pwn.txt")));
});

test("fs tools: write (approved) → list → read; size caps; binary refused", async () => {
  const { root } = await sandbox();
  const asks: string[] = [];
  const ctx: ToolContext = {
    workspaceDir: root,
    signal: new AbortController().signal,
    mode: "interactive",
    approve: async (ask) => {
      asks.push(ask.summary);
      return true;
    },
  };
  const w = await execute(fsWrite, JSON.stringify({ path: "notes/a.md", content: "xin chào" }), ctx);
  assert.equal(w.ok, true, w.output);
  assert.deepEqual(asks, ["Ghi notes/a.md (9 B)"]);
  const list = await execute(fsList, '{"depth":2}', ctx);
  assert.match(list.output, /notes\/\nnotes\/a\.md {2}\(9 B\)/);
  const r = await execute(fsRead, '{"path":"notes/a.md"}', ctx);
  assert.equal(r.output, "xin chào");
  await fs.writeFile(path.join(root, "big.txt"), "x".repeat(600_000));
  assert.match((await execute(fsRead, '{"path":"big.txt"}', ctx)).output, /limit/);
  await fs.writeFile(path.join(root, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  assert.match((await execute(fsRead, '{"path":"bin.dat"}', ctx)).output, /binary/);
  const tooBig = await execute(fsWrite, JSON.stringify({ path: "x.txt", content: "y".repeat(1_000_001) }), ctx);
  assert.equal(tooBig.ok, false);
  const rejected = await execute(fsWrite, JSON.stringify({ path: "no.txt", content: "n" }), { ...ctx, approve: async () => false });
  assert.equal(rejected.ok, false);
  await assert.rejects(() => fs.stat(path.join(root, "no.txt")));
});

test("http_fetch blocks private targets and redirects into them", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "172.20.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp("1.1.1.1"), false);
  const publicLookup = async () => ["93.184.216.34"];
  const privateLookup = async () => ["10.0.0.5"];
  await assert.rejects(() => checkUrl("http://localhost/", [], publicLookup), /internal/);
  await assert.rejects(() => checkUrl("http://169.254.169.254/latest", [], publicLookup), /private/);
  await assert.rejects(() => checkUrl("https://evil.example/", [], privateLookup), /private/);
  await assert.rejects(() => checkUrl("file:///etc/passwd", [], publicLookup), /http/);
  await assert.rejects(() => checkUrl("https://a.example:8443/", [], publicLookup), /ports/);
  await assert.rejects(() => checkUrl("https://other.com/", ["example.com"], publicLookup), /SABLE_FETCH_ALLOW/);
  assert.ok(await checkUrl("https://docs.example.com/x", ["*.example.com"], publicLookup));
  // Fake-IP egress (198.18/15) is only accepted for hostnames, and only when opted in.
  const fakeLookup = async () => ["198.18.0.1"];
  await assert.rejects(() => checkUrl("https://example.com/", [], fakeLookup), /private/);
  assert.ok(await checkUrl("https://example.com/", [], fakeLookup, true));
  await assert.rejects(() => checkUrl("http://198.18.0.1/", [], fakeLookup, true), /private/);
  await assert.rejects(() => checkUrl("http://127.0.0.1/", [], fakeLookup, true), /private/);
  await assert.rejects(() => checkUrl("https://x.example/", [], async () => ["198.18.0.1", "10.0.0.1"], true), /private/);
  assert.equal(hostAllowed("example.com", ["*.example.com"]), true);
  assert.equal(hostAllowed("badexample.com", ["*.example.com"]), false);

  const fakeFetch = (async (url: URL) => {
    if (url.hostname === "start.example") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    return new Response("<html><head><title>T</title><script>x()</script></head><body><p>Hello &amp; bye</p></body></html>", {
      headers: { "content-type": "text/html" },
    });
  }) as unknown as typeof fetch;
  const tool = createHttpFetch({ allow: [], lookup: publicLookup, fetchImpl: fakeFetch });
  const ctx: ToolContext = { workspaceDir: "/tmp", signal: new AbortController().signal, mode: "interactive" };
  const redirected = await execute(tool, '{"url":"https://start.example/"}', ctx);
  assert.equal(redirected.ok, false);
  assert.match(redirected.output, /internal|private/);
  const page = await execute(tool, '{"url":"https://page.example/"}', ctx);
  assert.equal(page.ok, true);
  assert.match(page.output, /^UNTRUSTED CONTENT from https:\/\/page\.example\//);
  assert.match(page.output, /# T\n\nHello & bye/);
  assert.ok(!page.output.includes("x()"));
  assert.equal(htmlToText("<li>a</li><li>b</li>"), "- a\n- b");
});

// --- Regression: e2e re-test 2026-11-03 ---

test("regression: fs_write never follows a dangling symlink out of the jail", async () => {
  const { root, outside } = await sandbox();
  const escaped = path.join(outside, "escaped.txt");
  await fs.symlink(escaped, path.join(root, "dangle"));
  await assert.rejects(() => jail(root, "dangle"), /outside workspace/);
  let asked = false;
  const ctx: ToolContext = { workspaceDir: root, signal: new AbortController().signal, mode: "interactive", approve: async () => (asked = true) };
  const out = await execute(fsWrite, JSON.stringify({ path: "dangle", content: "ESCAPED" }), ctx);
  assert.equal(out.ok, false);
  assert.equal(asked, false, "no approval card for a write that cannot happen");
  await assert.rejects(() => fs.stat(escaped));
});

test("regression: fs_write refuses a symlink target even when it points inside", async () => {
  const { root } = await sandbox();
  await fs.writeFile(path.join(root, "real.txt"), "orig");
  await fs.symlink(path.join(root, "real.txt"), path.join(root, "alias.txt"));
  const ctx: ToolContext = { workspaceDir: root, signal: new AbortController().signal, mode: "interactive", approve: async () => true };
  const out = await execute(fsWrite, JSON.stringify({ path: "alias.txt", content: "new" }), ctx);
  assert.equal(out.ok, false);
  assert.match(out.output, /symlink/);
  assert.equal(await fs.readFile(path.join(root, "real.txt"), "utf8"), "orig");
});

test("regression: fs_write outside the jail is refused before asking for approval", async () => {
  const { root } = await sandbox();
  let asked = 0;
  const ctx: ToolContext = { workspaceDir: root, signal: new AbortController().signal, mode: "interactive", approve: async () => (asked++, true) };
  for (const bad of ["../escape.txt", "a/../../x.txt", ""]) {
    const out = await execute(fsWrite, JSON.stringify({ path: bad, content: "x" }), ctx);
    assert.equal(out.ok, false, bad);
  }
  assert.equal(asked, 0);
  const ok = await execute(fsWrite, JSON.stringify({ path: "a/new.txt", content: "x" }), ctx);
  assert.equal(ok.ok, true);
  assert.equal(asked, 1);
});

test("regression: IPv6 forms that embed private IPv4 are blocked", async () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "::ffff:0:7f00:1", "2002:7f00:1::", "2001::1", "fe80::1%eth0", "ff02::1", "::", "::1", "::ffff:c612:1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) assert.equal(isPrivateIp(ip), false, ip);
  for (const url of ["http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::127.0.0.1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[::ffff:198.18.0.1]/"]) {
    await assert.rejects(() => checkUrl(url, [], async () => [], true), /private|internal/, url);
  }
});

test("regression: pinned fetch refuses to connect when DNS answers a private address", async () => {
  const tool = createHttpFetch({ allow: [], lookup: async () => ["93.184.216.34"], fakeIpEgress: false });
  const ctx: ToolContext = { workspaceDir: "/tmp/unused", signal: new AbortController().signal, mode: "interactive" };
  // checkUrl is fooled by the injected lookup; the connect-time lookup (real DNS: localhost → 127.0.0.1) must still block.
  const out = await execute(tool, '{"url":"http://localtest.me/"}', ctx);
  assert.equal(out.ok, false);
  assert.match(out.output, /private|internal|ENOTFOUND|EAI_AGAIN/);
});

test("regression: pinned fetch decodes gzip bodies like fetch() does", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(zlib.gzipSync(JSON.stringify({ hello: "xin chào" })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const res = await pinnedFetch(false)(`http://127.0.0.1:${port}/`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-encoding"), null);
    assert.deepEqual(await res.json(), { hello: "xin chào" });
  } finally {
    server.close();
  }
});
