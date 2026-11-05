/**
 * W4 test fixture "web": a local HTTP server that answers for a few invented public
 * hostnames (fictional Lumen Bridge pages). No external site is ever contacted:
 * DNS is injected (fixture hosts → TEST-NET-3 203.0.113.10, which passes the SSRF
 * checks like any public IP) and the fetch transport is redirected to 127.0.0.1:<port>.
 * Literal private targets (127.0.0.1, 169.254.169.254) still hit the real SSRF guard.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { FetchDeps } from "../tools/fetch.ts";
import type { SearchHit } from "./sources.ts";

const ROUTES: Record<string, string> = {
  "archive.valdora.gov/lumen": "lumen-history.html",
  "mirror.example-news.com/lumen-bridge": "lumen-mirror.html",
  "transport.valdora.gov/reports/2025": "lumen-maintenance.html",
  "forum.example-forum.com/t/lumen": "forum.html",
};

export const FIXTURE_HITS: SearchHit[] = [
  { url: "https://archive.valdora.gov/lumen?utm_source=search", title: "History of the Lumen Bridge" },
  { url: "https://www.archive.valdora.gov/lumen#top", title: "History of the Lumen Bridge (dup URL)" },
  { url: "https://mirror.example-news.com/lumen-bridge", title: "Lumen Bridge (mirror)" },
  { url: "https://transport.valdora.gov/reports/2025", title: "Lumen Bridge maintenance report 2025" },
  { url: "https://forum.example-forum.com/t/lumen", title: "Forum: is the Lumen Bridge safe?" },
  { url: "https://redirect.valdora.gov/go", title: "Redirect to an internal address" },
  { url: "http://169.254.169.254/latest/meta-data/", title: "Cloud metadata (must be blocked)" },
];

export async function startFixtureSite(siteDir: string): Promise<{ port: number; requests: string[]; deps: FetchDeps; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const host = String(req.headers["x-fixture-host"] ?? "");
    const key = `${host}${(req.url ?? "/").split("?")[0]}`;
    requests.push(key);
    if (key === "redirect.valdora.gov/go") {
      res.writeHead(302, { location: "http://127.0.0.1:8080/api/health" });
      return res.end();
    }
    const file = ROUTES[key];
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(siteDir, file)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const hosts = new Set(Object.keys(ROUTES).map((k) => k.split("/")[0]).concat("redirect.valdora.gov"));
  const deps: FetchDeps = {
    allow: [],
    lookup: async (h) => (hosts.has(h.replace(/^www\./, "")) ? ["203.0.113.10"] : ["10.0.0.1"]), // unknown → private → blocked
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-fixture-host": u.hostname.replace(/^www\./, "") }, redirect: "manual" });
    }) as typeof fetch,
  };
  return {
    port,
    requests,
    deps,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
