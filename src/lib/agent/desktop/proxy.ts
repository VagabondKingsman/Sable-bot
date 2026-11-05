/**
 * W3 egress guard for the desktop Chrome. Chrome runs with --proxy-server pointing here and
 * --proxy-bypass-list=<-loopback>, so every http(s) request (loopback included) goes through
 * this proxy, which applies the same SSRF rules as http_fetch (checkUrl: http(s) only, ports
 * 80/443, no localhost/.internal/private/link-local/metadata addresses) and then connects to the
 * address it validated (pinned: no DNS-rebinding window). Refusals are 403 and reported.
 */
import http from "node:http";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { checkUrl, type Lookup } from "../tools/fetch.ts";

export type EgressDeps = {
  allow?: string[];
  lookup?: Lookup;
  fakeIpEgress?: boolean;
  onBlock?: (target: string, reason: string) => void;
};

const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Validate a target and return the address to connect to. Throws with a reason when blocked. */
export async function resolveTarget(rawUrl: string, deps: EgressDeps = {}): Promise<{ url: URL; ip: string; port: number }> {
  const lookup = deps.lookup ?? defaultLookup;
  let seen: string[] = [];
  const url = await checkUrl(rawUrl, deps.allow ?? [], async (h) => (seen = await lookup(h)), deps.fakeIpEgress ?? false);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ip = net.isIP(host) ? host : seen[0];
  if (!ip) throw new Error("host did not resolve");
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return { url, ip, port };
}

export type EgressProxy = { port: number; close(): Promise<void>; blocked(): number };

export async function startEgressProxy(deps: EgressDeps = {}): Promise<EgressProxy> {
  let blocked = 0;
  const refuse = (target: string, error: unknown) => {
    blocked += 1;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      deps.onBlock?.(target.slice(0, 200), reason);
    } catch {
      /* reporting never breaks the proxy */
    }
    return reason;
  };
  const server = http.createServer(async (req, res) => {
    const target = req.url ?? "";
    try {
      const { url, ip, port } = await resolveTarget(target, deps);
      if (url.protocol !== "http:") throw new Error("plain requests must be http");
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      delete headers["proxy-authorization"];
      const up = http.request({ host: ip, port, method: req.method, path: `${url.pathname}${url.search}`, headers: { ...headers, host: url.host }, timeout: 30_000 }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      up.on("timeout", () => up.destroy());
      req.pipe(up);
    } catch (error) {
      const reason = refuse(target, error);
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Sable desktop: blocked (${reason})`);
    }
  });
  // Tunnels are detached from the http server, so track them for close().
  const tunnels = new Set<net.Socket | import("node:stream").Duplex>();
  server.on("connect", async (req, socket, head) => {
    const target = req.url ?? "";
    tunnels.add(socket);
    socket.on("close", () => tunnels.delete(socket));
    socket.on("error", () => socket.destroy());
    try {
      const { ip, port } = await resolveTarget(`https://${target}/`, deps);
      const up = net.connect({ host: ip, port });
      tunnels.add(up);
      up.on("close", () => tunnels.delete(up));
      up.setTimeout(120_000, () => up.destroy());
      up.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      up.on("error", () => socket.destroy());
      socket.on("close", () => up.destroy());
    } catch (error) {
      refuse(target, error);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as net.AddressInfo;
  return {
    port: addr.port,
    blocked: () => blocked,
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of tunnels) t.destroy();
        tunnels.clear();
        server.closeAllConnections?.();
        const timer = setTimeout(resolve, 1500); // never let a lingering socket wedge stop()
        server.close(() => (clearTimeout(timer), resolve()));
      }),
  };
}
