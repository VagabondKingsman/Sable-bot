import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { skills, skillsOn, writeSkillFile } from "@/server/skills.server";
import { cleanSkill, MAX_SKILLS, SKILL_NAME } from "@/lib/agent/skills/skills";

const NO_STORE = { "Cache-Control": "no-store" };

/** Skills CRUD. GET → list (?name= → one with body). POST {action:"save", skill} | {action:"delete", name}. */
export const Route = createFileRoute("/api/skills")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/skills", () => {
          const name = new URL(request.url).searchParams.get("name");
          const store = skills();
          if (name !== null) {
            const one = SKILL_NAME.test(name) ? store.get(name) : null;
            return one ? Response.json(one, { headers: NO_STORE }) : Response.json({ message: "Không có skill này." }, { status: 404 });
          }
          return Response.json(
            { enabled: skillsOn(), skills: store.list().map(({ name: n, description, tools, body }) => ({ name: n, description, tools, size: body.length })) },
            { headers: NO_STORE },
          );
        }),
      POST: ({ request }) =>
        guarded("POST /api/skills", async () => {
          if (!skillsOn()) return Response.json({ message: "Skill đang tắt (SABLE_SKILLS=0)." }, { status: 409 });
          const read = await readObjectBody(request, 64_000);
          if (!read.ok) return read.response;
          const body = read.body;
          const store = skills();
          if (body.action === "save") {
            const skill = cleanSkill(body.skill);
            if (typeof skill === "string") return Response.json({ message: skill }, { status: 422 });
            if (!store.get(skill.name) && store.list().length >= MAX_SKILLS) return Response.json({ message: `Tối đa ${MAX_SKILLS} skill.` }, { status: 422 });
            store.save(skill, writeSkillFile);
            return Response.json({ ok: true, name: skill.name });
          }
          if (body.action === "delete") {
            const ok = typeof body.name === "string" && store.remove(body.name);
            return ok ? Response.json({ ok: true }) : Response.json({ message: "Không có skill này." }, { status: 404 });
          }
          return Response.json({ message: "Hành động không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
