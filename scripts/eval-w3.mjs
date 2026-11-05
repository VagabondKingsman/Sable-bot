/**
 * W3 eval (desktop computer-use). Offline: the W3 unit suite (actions/bounds, secret redaction,
 * approval card + owner-only policy, background refusal, vision loop with mocks, heavy slots,
 * egress SSRF proxy). Deterministic E2E on :99 (lib session, local page, no external sites):
 * click / type / key via xdotool, page state verified by window title, egress probes blocked,
 * typed text never in argv. Live (running Sable): status, start, localhost-only VNC ports,
 * noVNC + CSP, WS origin gate + RFB banner, screenshot, other displays untouched, optional
 * vision run (grok-4.7) with owner approvals (--no-llm to skip), stop + footprint.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const results = [];
const pass = (n) => (results.push(["PASS", n]), console.log("PASS", n));
const skip = (n, why) => (results.push(["SKIP", n]), console.log("SKIP", n, "-", why));
function fail(n, e) {
  results.push(["FAIL", n]);
  console.error("FAIL", n, e?.message || e);
  process.exitCode = 1;
}
async function run(name, fn) {
  try {
    if ((await fn()) === "skip") return;
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = process.env.SABLE_EVAL_URL || "http://localhost:8080";
const DATA = process.env.SABLE_DATA_DIR || "/workspace/sable-data";
const PAGE = fs.readFileSync(new URL("../evals/desktop/eval-w3.html", import.meta.url), "utf8");
const noLlm = process.argv.includes("--no-llm");

const otherDisplays = () =>
  spawnSync("pgrep", ["-a", "Xvfb"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l && !/\sXvfb :99\b|\/Xvfb :99\b/.test(l))
    .sort()
    .join("\n");
const displaysBefore = otherDisplays();

await run("unit-suite-desktop", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "--test-reporter=tap", "src/lib/agent/desktop/desktop.test.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout.slice(-1500));
  assert.ok(/# pass (\d+)/.exec(r.stdout) && /# fail 0/.test(r.stdout));
});

let live = false;
try {
  live = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
} catch {}
const post = (b, h = {}) => fetch(`${BASE}/api/desktop`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
const status = async () => (await fetch(`${BASE}/api/desktop`)).json();

// The lib E2E needs :99 free: stop the server's session first (if live).
if (live) await post({ action: "stop" }).catch(() => {});
await sleep(1500);

await run("e2e-lib-:99-click-type-key-egress", async () => {
  const { DesktopSession } = await import("../src/lib/agent/desktop/session.ts");
  const { desktopConfig } = await import("../src/lib/agent/desktop/config.ts");
  const { parseAction, xdotoolSteps, describeAction } = await import("../src/lib/agent/desktop/actions.ts");
  const dir = fs.mkdtempSync("/tmp/sable-w3-eval-");
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  fs.writeFileSync(path.join(dir, "pages", "eval.html"), PAGE);
  const blocks = [];
  const s = new DesktopSession({ config: () => desktopConfig({ SABLE_DESKTOP_WM: "none" }), dir, egress: { fakeIpEgress: true, onBlock: (t) => blocks.push(t) } });
  s.deps.egress.onBlock = (t) => blocks.push(t);
  try {
    await s.start({ url: "file:///pages/eval.html" });
    const title = async (want) => {
      for (let i = 0; i < 40; i++) {
        const t = await s.activeWindowTitle();
        if (t.startsWith(want)) return t;
        await sleep(250);
      }
      throw new Error(`title never became ${want}: ${await s.activeWindowTitle()}`);
    };
    await title("w3-start");
    const jpeg = await s.screenshot();
    assert.ok(jpeg[0] === 0xff && jpeg[1] === 0xd8 && jpeg.length > 5000, "jpeg screenshot");
    const B = { width: 1280, height: 800 };
    const act = async (raw) => {
      const p = parseAction(raw, B);
      assert.ok(p.ok, p.error);
      for (const st of xdotoolSteps(p.value)) {
        assert.ok(!st.args.join(" ").includes("hello-w3"), "typed text must not be in argv");
        await s.xdotool(st.args, st.input);
      }
      return describeAction(p.value);
    };
    await act({ kind: "click", x: 640, y: 300 });
    await title("clicked:");
    await act({ kind: "click", x: 640, y: 540 });
    const d = await act({ kind: "type", text: "hello-w3", secret: true });
    assert.ok(!d.includes("hello-w3"));
    await act({ kind: "key", keys: "Return" });
    await title("submitted:hello-w3");
    assert.equal(parseAction({ kind: "click", x: 1280, y: 5 }, B).ok, false, "bounds");
    await sleep(500);
    assert.ok(s.proxy.blocked() >= 2, `egress probes blocked (${s.proxy.blocked()}): ${blocks.join(", ")}`);
    assert.ok(blocks.every((b) => !b.includes("?")), "block log strips queries");
  } finally {
    await s.stop("eval done");
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!fs.existsSync("/tmp/.X99-lock"), "lock released");
});

if (!live) skip("live", `${BASE} not reachable`);
else {
  fs.mkdirSync(path.join(DATA, "desktop", "pages"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "desktop", "pages", "eval-w3.html"), PAGE);

  await run("live-status-:99", async () => {
    const d = await status();
    assert.equal(d.display, ":99");
    assert.equal(d.enabled, true);
    assert.ok(d.heavy.max <= 2);
  });
  await run("live-start-localhost-only-vnc", async () => {
    const r = await post({ action: "start", url: "file:///pages/eval-w3.html" });
    const d = await r.json();
    assert.equal(r.status, 200, d.message);
    assert.equal(d.state, "running");
    assert.ok(d.viewUrl?.includes("#") && d.viewUrl.includes("path=/api/desktop/vnc"));
    const ss = execFileSync("ss", ["-ltnH"], { encoding: "utf8" });
    for (const port of [5999, 6099]) {
      const lines = ss.split("\n").filter((l) => new RegExp(`:${port}\\s`).test(l));
      assert.ok(lines.length > 0, `port ${port} listening`);
      assert.ok(lines.every((l) => /127\.0\.0\.1:/.test(l)), `port ${port} bound to localhost only`);
    }
  });
  await run("live-novnc-static-csp", async () => {
    const r = await fetch(`${BASE}/api/desktop/novnc/vnc.html`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'.*|script-src 'self' 'sha256-/);
    assert.equal((await fetch(`${BASE}/api/desktop/novnc/..%2f..%2f..%2fetc%2fpasswd`)).status, 404);
    assert.equal((await fetch(`${BASE}/api/desktop/novnc/.hidden.js`)).status, 404);
  });
  const wsProbe = (origin) =>
    new Promise((resolve) => {
      const u = new URL(BASE);
      const s = net.connect(Number(u.port || 80), u.hostname, () =>
        s.write(
          `GET /api/desktop/vnc HTTP/1.1\r\nHost: ${u.host}\r\n${origin ? `Origin: ${origin}\r\n` : ""}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: binary\r\n\r\n`,
        ),
      );
      let buf = Buffer.alloc(0);
      s.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.includes("RFB ") || /^HTTP\/1\.1 4\d\d/.test(buf.toString("latin1"))) s.destroy();
      });
      s.on("close", () => resolve(buf.toString("latin1")));
      s.on("error", () => resolve(buf.toString("latin1")));
      setTimeout(() => s.destroy(), 4000);
    });
  await run("live-ws-origin-gate-rfb", async () => {
    assert.match(await wsProbe(null), /^HTTP\/1\.1 403/);
    assert.match(await wsProbe("https://evil.example"), /^HTTP\/1\.1 403/);
    const ok = await wsProbe(BASE);
    assert.match(ok, /^HTTP\/1\.1 101/);
    assert.match(ok, /RFB 003\.00\d/);
  });
  await run("live-screenshot-no-approval", async () => {
    const r = await post({ action: "screenshot" });
    const d = await r.json();
    assert.equal(r.status, 200);
    const img = await fetch(`${BASE}${d.url}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.match(img.headers.get("cache-control") ?? "", /no-store/);
    assert.equal((await fetch(`${BASE}/api/desktop/shot/${"0".repeat(24)}`)).status, 404);
  });
  await run("live-decide-unknown-404-and-egress-blocked", async () => {
    const r = await post({ action: "decide", id: "nope", approve: true });
    assert.equal(r.status, 404);
    await sleep(1500);
    const d = await status();
    assert.ok(d.blockedRequests >= 2, `blocked ${d.blockedRequests}`);
  });
  await run("live-vision-run-with-owner-approvals", async () => {
    if (noLlm) return skip("live-vision-run-with-owner-approvals", "--no-llm"), "skip";
    const r = await post({ action: "run", goal: "Click the big blue 'Click me' button once. You are done when that button has turned green and shows 'Done'." });
    const d0 = await r.json();
    if (r.status === 409 && /vision/i.test(d0.message)) return skip("live-vision-run-with-owner-approvals", d0.message), "skip";
    assert.equal(r.status, 200, d0.message);
    const dup = await post({ action: "run", goal: "x" });
    assert.equal(dup.status, 409, "one run at a time");
    let approvals = 0;
    let d;
    for (let i = 0; i < 180; i++) {
      d = await status();
      for (const p of d.pending) {
        assert.match(p.image, /^\/api\/desktop\/shot\/[a-f0-9]{24}$/);
        // eval acts as the owner in the web UI
        const x = await post({ action: "decide", id: p.id, approve: true });
        assert.equal(x.status, 200);
        approvals++;
      }
      if (d.run && d.run.status !== "running") break;
      await sleep(1000);
    }
    assert.equal(d.run.status, "done", `${d.run.status}: ${d.run.summary} :: ${JSON.stringify(d.run.steps.map((s) => [s.action ?? s.note, s.state]))}`);
    assert.ok(approvals >= 1, "every click needed an approval");
    const shot = await post({ action: "screenshot" });
    assert.equal(shot.status, 200);
    console.log(`  vision run: ${d.run.steps.length} steps, ${approvals} approvals, $${d.run.usd.toFixed(3)}`);
  });
  await run("live-footprint-and-stop", async () => {
    const d = await status();
    const pids = Object.values(d.pids ?? {});
    const tree = new Set(pids);
    const ps = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number));
    for (let changed = true; changed; ) {
      changed = false;
      for (const [pid, ppid] of ps) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (changed = true));
    }
    const mb = ps.filter(([pid]) => tree.has(pid)).reduce((a, [, , rss]) => a + rss, 0) / 1024;
    console.log(`  desktop footprint: ${tree.size} processes, ${mb.toFixed(0)} MB RSS (sum)`);
    const r = await post({ action: "stop" });
    assert.equal((await r.json()).state, "stopped");
    await sleep(1000);
    assert.equal(spawnSync("pgrep", ["-f", "Xvfb :99"]).status, 1, "Xvfb :99 gone");
    assert.equal((await wsProbe(BASE)).slice(0, 12), "HTTP/1.1 404");
  });
}

await run("other-displays-untouched", () => {
  assert.equal(otherDisplays(), displaysBefore);
});

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\neval:w3 — ${results.filter((r) => r[0] === "PASS").length} pass, ${failed} fail, ${results.filter((r) => r[0] === "SKIP").length} skip`);
