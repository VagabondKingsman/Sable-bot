import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { evalsView, regressionRunning, runRegression, selfEvalOn, setReviewState, updateEvalSettings } from "@/server/evals.server";
import { ALL_SUITES } from "@/lib/agent/evals/store";

/**
 * W5 self-eval dashboard API (owner-only, behind desk auth).
 * GET  /api/evals  grades, review queue, settings, regression runs
 * POST {action:"settings", nightly?, time?, suites?} | {action:"run", suites?} | {action:"review", id, state:"resolved"|"dismissed"|"accepted"|"open"}
 * "accepted" only records the owner's approval of a proposal — nothing is applied automatically.
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/evals")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/evals", () => Response.json(evalsView(), { headers: NO_STORE })),
      POST: ({ request }) =>
        guarded("POST /api/evals", async () => {
          const read = await readObjectBody(request, 4_000);
          if (!read.ok) return read.response;
          const b = read.body;
          if (b.action === "review") {
            const states = ["resolved", "dismissed", "accepted", "open"];
            if (typeof b.id !== "string" || !/^rev_[a-z0-9_]{4,40}$/.test(b.id) || !states.includes(String(b.state))) return Response.json({ message: "id + state (resolved|dismissed|accepted|open) required." }, { status: 400 });
            const r = setReviewState(b.id, b.state as never);
            if (!r) return Response.json({ message: "not found" }, { status: 404 });
            audit({ type: "side_effect", initiator: USER, tool: "evals.review", summary: `${b.id} → ${b.state}`, ok: true });
            return Response.json({ ok: true, item: r }, { headers: NO_STORE });
          }
          if (!selfEvalOn()) return Response.json({ message: "Self-eval đang tắt (SABLE_SELFEVAL=0).", code: "disabled" }, { status: 403 });
          const suitesOk = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 12 && v.every((x) => (ALL_SUITES as readonly string[]).includes(x)));
          if (b.action === "settings") {
            if (b.nightly !== undefined && typeof b.nightly !== "boolean") return Response.json({ message: "nightly must be boolean." }, { status: 400 });
            if (b.time !== undefined && (typeof b.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time))) return Response.json({ message: "time must be HH:MM." }, { status: 400 });
            if (!suitesOk(b.suites)) return Response.json({ message: `suites ⊆ ${ALL_SUITES.join(",")}.` }, { status: 400 });
            const settings = await updateEvalSettings({ nightly: b.nightly as boolean | undefined, time: b.time as string | undefined, suites: b.suites as string[] | undefined });
            audit({ type: "side_effect", initiator: USER, tool: "evals.settings", summary: `nightly=${settings.nightly} ${settings.time}`, ok: true });
            return Response.json({ settings }, { headers: NO_STORE });
          }
          if (b.action === "run") {
            if (!suitesOk(b.suites)) return Response.json({ message: `suites ⊆ ${ALL_SUITES.join(",")}.` }, { status: 400 });
            if (regressionRunning()) return Response.json({ started: false, message: "Đang chạy." }, { status: 409, headers: NO_STORE });
            void runRegression({ manual: true, suites: b.suites as string[] | undefined });
            audit({ type: "side_effect", initiator: USER, tool: "evals.run", summary: `manual regression ${(b.suites as string[] | undefined)?.join(",") ?? "default suites"}`, ok: true });
            return Response.json({ started: true }, { headers: NO_STORE });
          }
          return Response.json({ message: "action phải là settings | run | review." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
