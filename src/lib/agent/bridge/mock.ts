/**
 * Local mock peer for tests + the panel's "test ping": an HTTP server on 127.0.0.1:<random>
 * that verifies sable.bridge.v1 signatures (own nonce cache) and answers ping with a signed pong,
 * handoffs with 202. Never reachable from outside the box; closed after use.
 */
import http from "node:http";
import { MAX_BODY, NonceCache, OUT_TYPES, H_NONCE, H_SIG, H_TS, makeMessage, parseMessage, signedHeaders, verify, type BridgeMessage } from "./protocol.ts";

export type MockPeer = { url: string; origin: string; received: BridgeMessage[]; rejected: { code: string }[]; headersSeen: Record<string, string>[]; close(): Promise<void> };

export function startMockPeer(secret: string, opts: { failWith?: number } = {}): Promise<MockPeer> {
  const received: BridgeMessage[] = [];
  const rejected: { code: string }[] = [];
  const headersSeen: Record<string, string>[] = [];
  const nonces = new NonceCache();
  const server = http.createServer((req, res) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n <= MAX_BODY) chunks.push(c);
    });
    req.on("end", () => {
      const send = (status: number, obj: unknown, signed = false) => {
        const body = JSON.stringify(obj);
        res.writeHead(status, signed ? signedHeaders(secret, body) : { "content-type": "application/json" });
        res.end(body);
      };
      const h = (k: string) => (req.headers[k] as string | undefined) ?? null;
      headersSeen.push(Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, k === "authorization" ? "[present]" : String(v)])));
      if (opts.failWith) return send(opts.failWith, { ok: false, code: "mock_fail" });
      if (n > MAX_BODY) return (rejected.push({ code: "too_large" }), send(413, { ok: false, code: "too_large" }));
      const raw = Buffer.concat(chunks).toString("utf8");
      const v = verify(secret, raw, { sig: h(H_SIG), ts: h(H_TS), nonce: h(H_NONCE) });
      if (!v.ok) return (rejected.push({ code: v.code }), send(401, { ok: false, code: v.code }));
      if (!nonces.claim(v.nonce)) return (rejected.push({ code: "replay" }), send(409, { ok: false, code: "replay" }));
      let p;
      try {
        p = parseMessage(JSON.parse(raw), OUT_TYPES);
      } catch {
        return send(400, { ok: false, code: "bad_request" });
      }
      if (!p.ok) return (rejected.push({ code: "bad_schema" }), send(422, { ok: false, code: "bad_schema" }));
      received.push(p.msg);
      if (p.msg.type === "ping") return send(200, makeMessage("pong", { text: "mock peer ok" }, { from: "peer", inReplyTo: p.msg.id }), true);
      send(202, { ok: true, id: p.msg.id, code: "accepted" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      const origin = `http://127.0.0.1:${addr.port}`;
      resolve({ url: `${origin}/hook`, origin, received, rejected, headersSeen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
