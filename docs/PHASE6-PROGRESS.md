# Phase 6 progress

**Last updated:** 2026-11-05 15:41 Asia/Saigon
 (times Asia/Saigon UTC+7)

Backup: `/workspace/sable-backup-pre-w0-202611050822.tgz`

Scope this wave: **W0** (suspend resilience + vault skeleton) + **reverse-skill architecture only** (router, ScopeGate, field-journal→memory, tool-index advisor). No RE/pentest/CTF scenario skills, PoCs, or auto-installers. MIT reverse-skill reference at `/workspace/reverse-skill-research` (do not vendor GPL CTF-Sandbox-Orchestrator). Do not touch AGENTS.project.md Content scope.

Accepted Full Agentic defaults: D1–D10 as on plan Page.

## Checklist

- [x] 0. Backup + PHASE6-PROGRESS + git checkpoint
- [x] 1. Box-suspend resilience (heartbeat, catch-up alias `SABLE_CATCHUP`, watchdog tick `/api/health`, DEPLOY.md)
- [x] 2. Secrets vault skeleton (`SABLE_VAULT`, AES-GCM `vault.json` 0600, API names-only list)
- [x] 3. 3-axis router + `skills/routing.json` (`SABLE_ROUTER`) — benign skills only + NOTICE
- [x] 4. ScopeGate fail-closed (`SABLE_SCOPE=0` deny-all ACT; execute.ts hook)
- [x] 5. field-journal → memory journal (`/api/field-journal`)
- [x] 6. tool-index scan + propose install (never auto; no RE tools)
- [x] 7. Unit tests + eval:w0; tsc; restart; ngrok 401/200; package `sable-source-w0-202611050831.tgz` SECRET_SCAN=CLEAN

## Notes

- Architecture adapted from reverse-skill MIT with attribution in `skills/_meta/NOTICE-reverse-skill.md`.
- Unit: heartbeat, vault, router, scope, journal, toolindex — 13/13. `npm run eval:w0` all pass. `tsc --noEmit` clean.

## W0 live verification (2026-11-05 15:30 Asia/Saigon)

- `/api/health` GET ok + heartbeat; POST tick ok
- `/api/router` 5 routes; classify `code review` → R2/code-review
- `/api/vault` list names only (`configured=false` until key)
- `/api/scope` killDeny=false, items=[]
- `/api/tool-index` 7 tools scanned, proposals propose-only
- `/api/field-journal` write → memory id
- ngrok: unauth **401**, basic auth **200**
- Unit: 13/13; `npm run eval:w0` pass; `tsc --noEmit` clean
- HARD SCOPE held: no apk/binary/js-reverse/pentest/CTF/exploit skills or auto RE installers
- Package:  SECRET_SCAN=CLEAN

## Known gaps / bugs (W0)
- ScopeGate approve/deny is **API-only** (`POST /api/scope`); no dedicated React approval card UI yet — wire into existing approval UX in W1.
- Git commits collapsed: most W0 code landed in `d2e5dcb` (intended per-item commits partially collapsed after early `git add -A`).
- Vault `configured=false` until `SABLE_VAULT_KEY` set; `.env.local` migrate path documented in DEPLOY.md, not auto-run.
- Watchdog restarted (pid refreshed) so POST `/api/health` tick is live.


## W1 · Planner / workspace / budget / ScopeGate UI (2026-11-05 15:33 Asia/Saigon)

Backup: `/workspace/sable-backup-pre-w1-202611050832.tgz`

Checklist:
- [x] 1. Planner/executor task graphs + checkpoints (`SABLE_PLANNER`)
- [x] 2. Per-task workspace under `/workspace/sable-workspace/tasks/<id>/` (`SABLE_WORKSPACES`)
- [x] 3. Cost/token budgeter + model router (`SABLE_BUDGET`)
- [x] 4. ScopeGate approval card in desk/background UX
- [x] 5. Unit + eval:w1; tsc; restart; ngrok 401/200; package CLEAN

## W1 live verification (2026-11-05 15:41 Asia/Saigon)

- Backup: 
-  create → waiting_approval on write_gate; workspace under tasks/<id>
-  enforce + pick hard=grok-4.7 (light=hard until SABLE_MODEL_LIGHT set)
- ScopeGate: create pending → POST /api/tools kind=scope approve → approved
- ngrok: unauth **401**, basic auth **200**
- Unit: 267/267; 
> eval:w1
> node --experimental-strip-types --no-warnings scripts/eval-w1.mjs

PASS plan-create-resume-after-crash
PASS workspace-isolation-3
PASS budget-trip
PASS scope-card-approve-deny

all w1 eval checks passed PASS;  clean
- Package:  SECRET_SCAN=CLEAN
- HARD SCOPE held: no RE/pentest/CTF skills

### Known gaps
- Planner agent steps dry-run unless JobRunner hook wired for full LLM enqueue (write_gate/note/classify/doc_audit solid).
- Light model equals hard until  configured.
- Budget meter not yet hooked into every live LLM response usage field (plan synthetic + API; job fail-closed on global cap before run).
