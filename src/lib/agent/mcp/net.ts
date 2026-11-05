/**
 * SSRF-guarded fetch for MCP transports. Same private-range rules as http_fetch
 * (isPrivateIp, checked at connect time, so DNS rebinding cannot slip through),
 * plus: no redirects, response bytes capped. `allowLocal` (env-only config) admits
 * loopback addresses only — never 10/8, 172.16/12, 192.168/16, 169.254/16, etc.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { Readable, Transform } from "node:stream";
import { isFakeIp, isPrivateIp } from "../tools/fetch.ts";

export const MAX_MCP_RESPONSE = 8 * 1024 * 1024;

export function isLoopback(ip: string) {
  const v = ip.replace(/^::ffff:/i, "");
  return v === "::1" || (net.isIPv4(v) && v.startsWith("127."));
}

export function addressAllowed(ip: string, allowLocal: boolean, fakeIpEgress = false, literal = false) {
  if (!isPrivateIp(ip)) return true;
  if (allowLocal && isLoopback(ip)) return true;
  return fakeIpEgress && !literal && isFakeIp(ip);
}

/** Static URL check before any connect. */
export function checkMcpUrl(raw: string, allowLocal: boolean): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowLocal)) throw new Error("MCP URL must be https");
  if (url.username || url.password) throw new Error("credentials in URL are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const localName = host === "localhost" || host.endsWith(".localhost");
  if ((localName && !allowLocal) || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("internal host blocked");
  if (net.isIP(host) && !addressAllowed(host, allowLocal, false, true)) throw new Error("private/internal address blocked");
  return url;
}

type LookupCb = (error: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

export function mcpFetch(allowLocal: boolean, fakeIpEgress = false, cap = MAX_MCP_RESPONSE): typeof fetch {
  const guardedLookup = (host: string, options: { all?: boolean }, callback: LookupCb) => {
    dnsLookup(host, { all: true, verbatim: true }).then(
      (list) => {
        const literal = net.isIP(host) !== 0;
        if (!list.length || list.some((i) => !addressAllowed(i.address, allowLocal, fakeIpEgress, literal))) {
          const error: NodeJS.ErrnoException = new Error("private/internal address blocked");
          error.code = "EBLOCKED";
          callback(error, "", 0);
          return;
        }
        if (options?.all) callback(null, list.map((i) => ({ address: i.address, family: i.family })));
        else callback(null, list[0].address, list[0].family);
      },
      (error: NodeJS.ErrnoException) => callback(error, "", 0),
    );
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = checkMcpUrl(typeof input === "string" || input instanceof URL ? input.toString() : input.url, allowLocal);
    const method = (init?.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "DELETE"].includes(method)) throw new Error(`method ${method} not allowed`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: Buffer | undefined;
    if (init?.body != null) {
      if (typeof init.body !== "string") throw new Error("only string bodies");
      body = Buffer.from(init.body);
      if (body.length > 2 * 1024 * 1024) throw new Error("request too large");
      headers["content-length"] = String(body.length);
    }
    const lib = url.protocol === "https:" ? https : http;
    return await new Promise<Response>((resolve, reject) => {
      const req = lib.request(url, { method, headers, lookup: guardedLookup as unknown as typeof import("node:dns").lookup, signal: init?.signal ?? undefined }, (res) => {
        const out = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) for (const i of v) out.append(k, i);
          else if (v !== undefined) out.set(k, String(v));
        }
        const status = res.statusCode ?? 502;
        // No redirects: a 3xx is returned as-is (the SDK treats it as an error).
        let seen = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _enc, done) {
            seen += chunk.length;
            if (seen > cap) done(new Error(`MCP response larger than ${cap} bytes`));
            else done(null, chunk);
          },
        });
        res.on("error", (e) => limiter.destroy(e));
        const nullBody = status === 204 || status === 304 || status < 200 || method === "DELETE";
        if (nullBody) res.resume();
        resolve(new Response(nullBody ? null : (Readable.toWeb(res.pipe(limiter)) as unknown as ReadableStream<Uint8Array>), { status: status >= 200 && status <= 599 ? status : 502, headers: out }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}
