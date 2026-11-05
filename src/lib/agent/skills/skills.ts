/**
 * Skill runtime: `skills/<name>/SKILL.md` with frontmatter (name, description, tools).
 * Separate from `.grok/skills` (coding-agent skills). Skills are instructions only:
 * they never grant a tool — `tools` is a hint checked against what the turn allows.
 */
import fs from "node:fs";
import path from "node:path";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_SKILL_BODY = 8_000;
export const MAX_SKILL_FILE = 16_000;
export const MAX_CATALOG = 1_500;
export const MAX_SKILLS = 50;
const MAX_DESC = 300;

export type Skill = { name: string; description: string; tools: string[]; body: string };

/** Parse `---\nkey: value\n---\nbody`. tools: `[a, b]` or `a, b`. */
export function parseSkill(text: string, fallbackName = ""): Skill | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-zA-Z_]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  const name = (meta.name || fallbackName).trim();
  if (!SKILL_NAME.test(name)) return null;
  const description = (meta.description || "").replace(/\s+/g, " ").slice(0, MAX_DESC);
  if (!description) return null;
  const tools = (meta.tools || "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter((t) => /^[a-z][a-z0-9_]{1,80}$/.test(t))
    .slice(0, 20);
  return { name, description, tools, body: m[2].trim() };
}

export function renderSkill(s: Skill) {
  return `---\nname: ${s.name}\ndescription: ${s.description.replace(/\s+/g, " ")}\ntools: [${s.tools.join(", ")}]\n---\n\n${s.body.trim()}\n`;
}

/** Validate a skill coming from the UI. Returns an error string or the clean skill. */
export function cleanSkill(input: unknown): Skill | string {
  if (!input || typeof input !== "object") return "Dữ liệu skill không hợp lệ.";
  const o = input as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!SKILL_NAME.test(name)) return "Tên skill chỉ gồm a-z, 0-9, dấu gạch ngang (tối đa 48 ký tự).";
  const description = typeof o.description === "string" ? o.description.replace(/\s+/g, " ").trim() : "";
  if (!description || description.length > MAX_DESC) return `Mô tả bắt buộc, tối đa ${MAX_DESC} ký tự.`;
  const body = typeof o.body === "string" ? o.body.trim() : "";
  if (!body) return "Nội dung skill trống.";
  if (body.length > MAX_SKILL_BODY) return `Nội dung tối đa ${MAX_SKILL_BODY} ký tự.`;
  const raw = Array.isArray(o.tools) ? o.tools : typeof o.tools === "string" ? o.tools.split(",") : [];
  const tools = raw.map((t) => String(t).trim()).filter(Boolean);
  const bad = tools.find((t) => !/^[a-z][a-z0-9_]{1,80}$/.test(t));
  if (bad) return `Tên công cụ không hợp lệ: ${bad.slice(0, 40)}`;
  return { name, description, tools: [...new Set(tools)].slice(0, 20), body };
}

export type SkillStore = {
  dir: string;
  list(): Skill[];
  get(name: string): Skill | null;
  save(skill: Skill, write: (file: string, data: string) => void): void;
  remove(name: string): boolean;
};

export function skillStore(dir: string): SkillStore {
  const fileOf = (name: string) => path.join(dir, name, "SKILL.md");
  const get = (name: string): Skill | null => {
    if (!SKILL_NAME.test(name)) return null;
    try {
      const file = fileOf(name);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_SKILL_FILE) return null;
      return parseSkill(fs.readFileSync(file, "utf8"), name);
    } catch {
      return null;
    }
  };
  return {
    dir,
    get,
    list() {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && SKILL_NAME.test(d.name)).map((d) => d.name).sort();
      } catch {
        return [];
      }
      return names.slice(0, MAX_SKILLS).map(get).filter((s): s is Skill => Boolean(s));
    },
    save(skill, write) {
      fs.mkdirSync(path.join(dir, skill.name), { recursive: true, mode: 0o700 });
      write(fileOf(skill.name), renderSkill(skill));
    },
    remove(name) {
      if (!SKILL_NAME.test(name) || !get(name)) return false;
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      return true;
    },
  };
}

/** One line per skill, within MAX_CATALOG characters. Missing tools are flagged, never granted. */
export function skillCatalog(skills: Skill[], enabled: Set<string>, max = MAX_CATALOG): string {
  if (!skills.length) return "";
  const head = "Skills (call load_skill(name) to read one before following it; skills never add tools):";
  const lines = [head];
  let used = head.length;
  let dropped = 0;
  for (const s of skills) {
    const missing = s.tools.filter((t) => !enabled.has(t));
    const line = `- ${s.name}: ${s.description}${missing.length ? ` (cần bật: ${missing.join(", ")})` : ""}`.slice(0, 400);
    if (used + 1 + line.length > max - 40) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  if (dropped) lines.push(`(+${dropped} skill khác không vừa danh mục)`);
  return lines.join("\n");
}

/** The `loaded` block load_skill returns into the turn. */
export function loadedBlock(s: Skill, enabled: Set<string>): string {
  const body = s.body.length > MAX_SKILL_BODY ? `${s.body.slice(0, MAX_SKILL_BODY)}\n[…cắt]` : s.body;
  const missing = s.tools.filter((t) => !enabled.has(t));
  const note = missing.length
    ? `\nNote: this skill mentions tools not enabled this turn (${missing.join(", ")}). Do not try to call them; tell the user to enable them if needed.`
    : "";
  return `<loaded skill="${s.name}">\n${body}\n</loaded>${note}`;
}
