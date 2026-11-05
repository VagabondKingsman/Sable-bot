export function parseExtraOrigins(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const v = part.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol !== "https:" || u.username || u.password) continue;
      if (u.pathname !== "/" || u.search || u.hash || v.includes("*")) continue;
      if (!out.includes(u.origin)) out.push(u.origin);
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}
