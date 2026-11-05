/**
 * Fails if application code reads process.env.X / import.meta.env.X / env("X")
 * for a name that is not mentioned in .env.example (as KEY= or # KEY=).
 * Allowlists OS/runtime and a few platform-injected names documented as optional.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const EXAMPLE = join(ROOT, ".env.example");

const ALLOW = new Set([
  "PATH", "HOME", "USER", "PWD", "SHELL", "LANG", "TERM", "CI", "NODE_ENV", "NODE_OPTIONS", "TZ", "DISPLAY",
  "SABLE_EVAL_NIGHTLY", // set by evals.server for child processes only
]);

const READ_RE = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
  /\benv\(["']([A-Z][A-Z0-9_]*)["']\)/g,
  /\benv\.([A-Z][A-Z0-9_]*)\b/g,
  /\bsecret\(\s*env\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g,
  /\bflagOn\(\s*["']([A-Z][A-Z0-9_]*)["']\)/g,
];

const SKIP_DIR = new Set(["node_modules", ".git", "dist", ".output", ".vinxi", ".tanstack", ".vercel", "artifacts", "attachments", "screenshots", "evals"]);
const SKIP_FILE = /\.(test|spec)\.(ts|tsx|mjs|js)$/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|mts)$/.test(name) && !SKIP_FILE.test(name)) out.push(p);
  }
  return out;
}

function documentedKeys(text) {
  const keys = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
    // vault names mentioned in comments
    for (const m2 of line.matchAll(/\b(BRIDGE_[A-Z0-9_]+|GOOGLE_OAUTH_[A-Z0-9_]+|OAUTH_TOKEN_[A-Z0-9_]+)\b/g)) keys.add(m2[1]);
  }
  return keys;
}

function codeKeys() {
  const found = new Map();
  const files = [
    ...walk(join(ROOT, "src")),
    ...walk(join(ROOT, "scripts")).filter((p) => !p.endsWith("check-env-example.mjs")),
    join(ROOT, "vite.config.ts"),
    join(ROOT, "server"),
  ].filter((p) => {
    try { return statSync(p).isFile(); } catch { return false; }
  });
  // also any top-level server/*.ts if present as dir
  try { files.push(...walk(join(ROOT, "server"))); } catch { /* none */ }
  for (const file of new Set(files)) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const re of READ_RE) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const k = m[1];
        if (!found.has(k)) found.set(k, relative(ROOT, file));
      }
    }
    // flagOn("SABLE_JOBS") style already covered; also num("SABLE_JOB_CONCURRENCY"
    for (const m of text.matchAll(/\b(?:num|int)\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) {
      if (!found.has(m[1])) found.set(m[1], relative(ROOT, file));
    }
    for (const m of text.matchAll(/process\.env\[name\]/g)) {
      // dynamic — skip
    }
  }
  // startup.sh
  try {
    const sh = readFileSync(join(ROOT, "startup.sh"), "utf8");
    for (const m of sh.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
      if (!found.has(m[1])) found.set(m[1], "startup.sh");
    }
  } catch { /* */ }
  return found;
}

test(".env.example documents every env var the app code reads", () => {
  const example = readFileSync(EXAMPLE, "utf8");
  assert.ok(example.length > 500, ".env.example missing or too short");
  const doc = documentedKeys(example);
  const code = codeKeys();
  const missing = [];
  for (const [k, file] of [...code.entries()].sort()) {
    if (ALLOW.has(k)) continue;
    if (doc.has(k)) continue;
    missing.push(`${k} (from ${file})`);
  }
  assert.deepEqual(missing, [], `Add these to .env.example:\n${missing.join("\n")}`);
});
