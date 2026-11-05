import path from "node:path";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { loadedBlock, skillCatalog, skillStore, type SkillStore } from "@/lib/agent/skills/skills";

/** SABLE_SKILLS=0 is the kill switch (no catalog, no load_skill, UI read-only). */
export function skillsOn() {
  return (process.env.SABLE_SKILLS ?? "1").trim() !== "0";
}

export function skillsDir() {
  return path.resolve(process.env.SABLE_SKILLS_DIR?.trim() || path.join(process.cwd(), "skills"));
}

export function skills(): SkillStore {
  return skillStore(skillsDir());
}

export { writeAtomic as writeSkillFile };

/** Catalog text + ToolContext access for one turn, given the tool names live this turn. */
export function skillsForTurn(enabledNames: string[]) {
  if (!skillsOn()) return null;
  const store = skills();
  const list = store.list();
  if (!list.length) return null;
  const enabled = new Set(enabledNames);
  return {
    catalog: skillCatalog(list, enabled),
    access: {
      names: () => store.list().map((s) => s.name),
      load: (name: string) => {
        const s = store.get(name);
        return s ? loadedBlock(s, enabled) : null;
      },
    },
  };
}
