import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  browserNeedsApproval,
  browserOn,
  browserTool,
  closeBrowser,
  setBrowserDeps,
} from "./tools/browser.ts";
import { checkUrl } from "./tools/fetch.ts";
import { execute } from "./tools/execute.ts";
import { FLAG_OF } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-br-"));

test("browser: write actions need approval; read do not", () => {
  assert.equal(browserNeedsApproval("click"), true);
  assert.equal(browserNeedsApproval("type"), true);
  assert.equal(browserNeedsApproval("submit"), true);
  assert.equal(browserNeedsApproval("navigate"), false);
  assert.equal(browserNeedsApproval("text"), false);
  assert.equal(browserNeedsApproval("screenshot"), false);
  assert.equal(FLAG_OF.browser, "browser");
});

test("browser: SSRF blocks loopback navigate (same checkUrl as http_fetch)", async () => {
  await assert.rejects(() => checkUrl("http://127.0.0.1/", []), /private|internal|blocked/i);
  await assert.rejects(() => checkUrl("http://localhost/", []), /internal|blocked/i);
  const ws = tmp();
  const ctx: ToolContext = { workspaceDir: ws, signal: AbortSignal.timeout(5_000), mode: "interactive" };
  const out = await browserTool.run({ action: "navigate", url: "http://127.0.0.1:9/" }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.output, /private|internal|blocked|browser error/i);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("browser: click refused without approver; rejected approval does nothing", async () => {
  await closeBrowser();
  let clicks = 0;
  const fakePage = {
    goto: async () => undefined,
    url: () => "https://example.com/",
    title: async () => "t",
    innerText: async () => "body",
    content: async () => "<html></html>",
    screenshot: async () => Buffer.from("png"),
    click: async () => {
      clicks += 1;
    },
    fill: async () => undefined,
    selectOption: async () => undefined,
    press: async () => undefined,
    evaluate: async () => undefined,
    close: async () => undefined,
  };
  setBrowserDeps({
    checkUrl: async (u) => new URL(u),
    chromium: {
      launch: async () => ({
        newPage: async () => fakePage,
        close: async () => undefined,
      }),
    },
  });
  const ws = tmp();
  const base: ToolContext = { workspaceDir: ws, signal: new AbortController().signal, mode: "interactive" };
  const noAppr = await execute(browserTool, JSON.stringify({ action: "click", selector: "#go" }), base);
  // needsApproval is false statically; runtime gate returns refused
  assert.equal(noAppr.ok, false);
  assert.match(noAppr.output, /approval|approver|refused|rejected/i);
  assert.equal(clicks, 0);

  const rejected = await execute(browserTool, JSON.stringify({ action: "click", selector: "#go" }), {
    ...base,
    approve: async () => false,
  });
  assert.equal(rejected.ok, false);
  assert.equal(clicks, 0);

  const ok = await execute(browserTool, JSON.stringify({ action: "click", selector: "#go" }), {
    ...base,
    approve: async (ask) => {
      assert.match(ask.summary, /click/i);
      return true;
    },
  });
  assert.equal(ok.ok, true, ok.output);
  assert.equal(clicks, 1);

  // background never auto-approves
  const bg = await execute(browserTool, JSON.stringify({ action: "type", selector: "input", text: "x" }), {
    workspaceDir: ws,
    signal: new AbortController().signal,
    mode: "background",
  });
  assert.equal(bg.ok, false);

  await closeBrowser();
  setBrowserDeps({});
  fs.rmSync(ws, { recursive: true, force: true });
});

test("browser: kill switch SABLE_BROWSER=0", async () => {
  const prev = process.env.SABLE_BROWSER;
  process.env.SABLE_BROWSER = "0";
  assert.equal(browserOn(), false);
  const ws = tmp();
  const r = await execute(
    browserTool,
    JSON.stringify({ action: "navigate", url: "https://example.com/" }),
    { workspaceDir: ws, signal: new AbortController().signal, mode: "interactive" },
  );
  assert.match(r.output, /SABLE_BROWSER=0|tắt/i);
  process.env.SABLE_BROWSER = prev;
  fs.rmSync(ws, { recursive: true, force: true });
});

test("browser: live Chromium — setContent, type+click with approval, screenshot to workspace", async () => {
  setBrowserDeps({}); // real playwright
  const ws = tmp();
  const ctx: ToolContext = {
    workspaceDir: ws,
    signal: AbortSignal.timeout(60_000),
    mode: "interactive",
    approve: async () => true,
  };
  // Use about:blank then inject HTML via a navigate to a data URL — data: is not http(s),
  // so instead drive the page through the shared session after a guarded public navigate,
  // or use evaluate via a tiny local server with injected checkUrl that allows 127.0.0.1 for this test only.
  const html = `<!doctype html><html><body>
    <form id="f"><input id="name" name="n" /><button id="go" type="submit">Go</button></form>
    <div id="out"></div>
    <script>document.getElementById('f').onsubmit=e=>{e.preventDefault();document.getElementById('out').textContent='HI:'+document.getElementById('name').value};</script>
  </body></html>`;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  setBrowserDeps({
    checkUrl: async (raw) => {
      const u = new URL(raw);
      if (u.hostname === "127.0.0.1" && u.port === String(port)) return u;
      return checkUrl(raw, []);
    },
  });
  const nav = await browserTool.run({ action: "navigate", url: `http://127.0.0.1:${port}/` }, ctx);
  assert.equal(nav.ok, true, nav.output);
  const typed = await browserTool.run({ action: "type", selector: "#name", text: "Sable" }, ctx);
  assert.equal(typed.ok, true, typed.output);
  const clicked = await browserTool.run({ action: "click", selector: "#go" }, ctx);
  assert.equal(clicked.ok, true, clicked.output);
  const text = await browserTool.run({ action: "text", selector: "#out" }, ctx);
  assert.match(text.output, /HI:Sable/);
  const shot = await browserTool.run({ action: "screenshot" }, ctx);
  assert.equal(shot.ok, true, shot.output);
  assert.ok(fs.existsSync(path.join(ws, ".sable-browser")));
  await closeBrowser();
  setBrowserDeps({});
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
});
