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

- Backup: `/workspace/sable-backup-pre-w1-202611050832.tgz`
- `/api/tasks` create → waiting_approval on write_gate; workspace under tasks/<id>
- `/api/budget` enforce + pick hard=grok-4.7 (light=hard until SABLE_MODEL_LIGHT set)
- ScopeGate: create pending → POST /api/tools kind=scope approve → approved
- ngrok: unauth **401**, basic auth **200**
- Unit: 267/267; `npm run eval:w1` all PASS; `tsc --noEmit` clean
- Package: `/workspace/sable-source-w1-202611050841.tgz` SECRET_SCAN=CLEAN
- HARD SCOPE held: no RE/pentest/CTF skills

### Known gaps (W1)
- Planner `agent` steps dry-run unless JobRunner hook is wired for full LLM enqueue (note/classify/write_gate/doc_audit are solid).
- Light model equals hard until `SABLE_MODEL_LIGHT` is configured.
- Budget meter not yet hooked into every live LLM response usage field (plan uses synthetic tokens; jobs fail-closed on global cap before run).


## W2 · Trace UI / media / Canvas pages (started 2026-11-05 15:48 Asia/Saigon)

Backup: `/workspace/sable-backup-pre-w2-202611050847.tgz`

Built in parallel with the OpenDuet research worker (no edits to `/workspace/openduet-research` or `/workspace/reverse-skill-research`).

Checklist:
- [x] 1. Observability / trace UI (`SABLE_TRACE`): `/api/traces`, `/api/traces/<id>`, timeline tab, tool filter, JSON export, archive >= 7 days
- [x] 2. Image & video generation (`SABLE_MEDIA`): xAI + OpenAI-compatible image adapters, video only with a real provider, media library, gallery, budget
- [x] 3. Canvas-style Pages (`SABLE_CANVAS`): sandboxed iframe + CSP, versions, list/read API, open beside chat
- [x] 4. Unit + eval:w2; tsc; restart; ngrok 401/200; package CLEAN

## W2 live verification (2026-11-05 16:12 Asia/Saigon)

- Trace: `/api/traces` 200 (12 runs, retention 14 d, floor 7 d), `/api/traces/<id>?export=1` → `sable.trace.v1` attachment; bad id 400; archive files 0600.
- Media: real xAI image generated (`grok-imagine-image-2.0`, b64, JPEG sniffed, 70 KB) → `/workspace/sable-workspace/media/`, index in `sable-data/media/` (0600); gallery shows it. OpenAI-compatible adapter honestly "chưa cấu hình" (no `SABLE_IMAGE_BASE_URL`). Video: xAI configured; not live-generated this wave (cost) — covered by unit tests with a mocked provider.
- Canvas: owner create/update via API → v1/v2; `/view` carries `CSP: sandbox allow-scripts; default-src 'none'; connect-src 'none' …` + nosniff (also through ngrok). Agent `canvas_write` end-to-end: approval card → approved → `c_e6a1…` v1. Headless Chrome probe inside the frame: `origin=null`, parent access blocked, `fetch` blocked by CSP, `localStorage` blocked; script (counter button) runs. Pane opens beside the chat.
- Restart: dev server killed → watchdog relaunched in ~21 s; `/api/health` 200.
- ngrok: unauth **401**, basic auth **200** (`/`, `/api/canvas`; `/api/traces`, `/api/media` 200 with auth).
- Unit: 197 + 284 pass; `npm run eval:w2` 10/10 PASS (7 offline + 3 live); eval:w0/w1 still PASS; `tsc --noEmit` clean.
- Package: `/workspace/sable-source-w2-202611050911.tgz` SECRET_SCAN=CLEAN (4 live secrets + key patterns checked; one deliberate `ghp_fixture…` test fixture allow-listed)
- HARD SCOPE held: no RE/pentest/CTF skills; Content scope untouched.

### Bugs found/fixed (W2)
- Trace archive test flaked on `Date.now()` in fixture → fixed fixture.
- `unite` produced `undefined` keys for tool/at/ms → conditional spreads.
- `canvas_write` first registered under the `files` flag changed every Files-on tool list (3 tests failed) → own server-set `canvas` flag (SABLE_CANVAS && Files).
- First live image recorded $0 in the meter because the running server held a pre-W2 BudgetMeter singleton (no fixed `usd`); fixed by restart, the one event corrected to $0.07 (backup `/tmp/budget-usage.bak.json`).

### Known gaps (W2)
- No agent tool for media yet (generate from the Media tab / `/api/media`; chat Ảnh/Video buttons use the same library path).
- Canvas pages cannot load CDN libs or remote images (strict CSP by design); share link = authenticated desk URL (no separate revocable share token).
- A sandboxed canvas can still navigate its own frame (CSP can't block self-navigation); mitigated by approval on `canvas_write` + no-referrer + no cookies in the opaque origin.
- Trace latency for older (pre-W2) records is parsed from "ok · N ms" text; no `at` timestamp on them.


## W2a · Proactive core (started 2026-11-05 16:15 Asia/Saigon)

Backup: `/workspace/sable-backup-pre-w2a-202611050915.tgz`

Approved revised plan from the Duet audit Page. Patterns adapted from OpenDuet (MIT, CopilotKit) — see `skills/_meta/NOTICE-openduet.md`. OpenBot is not vendored; no CopilotKit Intelligence dependency.

Checklist:
- [x] 1. Triage (`SABLE_TRIAGE`): needs-reply / needs-approval / FYI / ignore with reasons; rules first, light model only when `SABLE_MODEL_LIGHT`; `evals/triage`
- [x] 2. Morning brief (`SABLE_BRIEF`): built-in routine, default off, 07:30 Asia/Saigon; inbox + Telegram when configured
- [x] 3. Tasks inbox UX: planner tasks + approvals + triaged items, states todo/doing/waiting-approval/done
- [x] 4. Reply chips: approve / snooze / draft reply / open task; never auto-send
- [x] 5. initiator_kind audit (user|routine|trigger|agent|subagent|channel) on side effects + approvals; `/api/audit`; no background self-approve
  - `src/lib/agent/audit/{types,policy,log}.ts`, `src/server/audit.server.ts` (`decideAs`/`decideStepAs`), `GET /api/audit`; every decide path (web tools/tasks/scope, Telegram, webhook) goes through `canDecide`; routine/trigger/agent/subagent deciders denied (`approval.denied_policy`), webhook peer cannot approve its own chain; channels keep jobs-only reach. Trace list/detail show initiator badge + per-job audit strip; Tasks inbox shows "bởi <kind>". Summaries redacted.
- [x] 6. Unit + eval:w2a + evals w0/w1/w2; tsc; restart; ngrok 401/200; package CLEAN

### W2a verification (2026-11-05, ~16:35 ICT)
- Unit: 197 + 306 pass (adds proactive triage/brief/unify/chips + audit tests); `tsc --noEmit` clean.
- `npm run eval:w2a` 11/11 PASS (7 offline + 4 live): triage gates (40 invented items, 100% acc; self-authored set, likely optimistic), injection can't create an approval, brief default off 07:30 Asia/Saigon + composition, chips never send, initiator_kind on every audit record + trace, background/webhook self-approve denied. eval:w0/w1/w2 still PASS.
- Restart via watchdog: /api/health, /api/triage, /api/brief, /api/audit, /api/tasks?view=inbox, /api/traces → 200; ngrok 401 without auth / 200 with auth.
- Package: `/workspace/sable-source-w2a-<stamp>.tgz` SECRET_SCAN=CLEAN (live SABLE_PASSWORD/XAI_API_KEY/ngrok token not present; key-pattern hits are deliberate fake test fixtures only; no .env files).

### W2a bugs fixed / gaps
- Fixed: triage heuristic missed "please update/pay"; webhook fromOwner now uses configured ownerPeerId; `decideAs` initially widened channel reach → `jobsOnly` for Telegram/webhook; `@ts-nocheck` on evals/triage/run.mjs (triage commit alone had tsc errors, fixed in next commit).
- Gaps: morning brief is a built-in ticker (`builtin:morning-brief`), not a routines.json entry; brief is deterministic (no LLM); model triage only when SABLE_MODEL_LIGHT is set (else rules + heuristic); old archived traces have no initiator badge; plan traces are labelled `agent` (planner) even though the owner created the plan; decideAs/HTTP decide paths covered by eval policy + live 404/405 checks, not by an end-to-end routine-ask live test.

## W2b — OAuth connectors (Gmail + Google Calendar)

Backup: `/workspace/sable-backup-pre-w2b-202611050938.tgz`. Live Google sign-in: **needs He's OAuth client ID/secret** (see `docs/OAUTH-SETUP.md`); everything is E2E-tested against a local mock.

- [x] 1. Generic OAuth2 (PKCE S256 + state, auth-code, refresh, revoke); tokens only in the W0 vault, redacted everywhere; redirect URI on the public origin; owner-only; `SABLE_OAUTH` kill switch; connector registry + Settings Connect/Disconnect
- [x] 2. Gmail: search/read threads, read message, labels; create draft; send only via approval card (never background initiators); new mail → triage + brief
- [x] 3. Google Calendar: calendars/events/free-busy; create/update/delete need approval; today's events → brief
- [x] 4. Mock OAuth + Gmail/Calendar E2E; eval:w2b; tsc; evals w0/w1/w2/w2a; restart; ngrok 401/200; package CLEAN

### W2b verification (2026-11-05)

- `tsc --noEmit` clean. `npm test`: script suites 197/197 and TS suites 323/323. That includes the new `connectors.test.ts` (17 E2E tests against the mock Google).
- Evals:
  - w0, w1, w2 (10), w2a (11): pass
  - **w2b: 15/15**. Offline: PKCE/state, vault-only tokens, refresh on 401, host allowlist, send needs approval, background send denied, calendar writes need approval, revoke, redaction. Live: registry shape with no secrets, callback 400 with no-referrer/CSP/no-store, connect 404/409, vault refuses OAUTH_TOKEN_*, brief OK.
- Restart via the watchdog: local `/`, `/api/health`, `/api/connectors` and `/api/brief` all 200. ngrok returns 401 without auth and 200 with it; callback with a bad state returns 400 through ngrok.
- Live server state: gmail and gcal are **not-configured** because `SABLE_VAULT_KEY` and the Google client are not set. This needs He's credentials (docs/OAUTH-SETUP.md).

Bugs found and fixed in W2b:
- `/api/vault` get could have returned OAuth tokens. It now refuses `OAUTH_TOKEN_*` except `has`.
- gmail_send had no draft-id path. Sends are compose-only, so the approval card shows exactly what will be sent.

Gaps / follow-ups:
- Live Google is untested: it needs He's OAuth client and a vault key. In Testing mode refresh tokens expire after 7 days.
- Calendar has no attendees or invitations (`sendUpdates=none`) and no recurring-event editing (instances only).
- Gmail sends text/plain only, with no attachments. Sync covers the last 2 days, 25 messages, every 10 minutes; there is no push or history-id incremental sync.
- Pending OAuth states are in memory, so a server restart during consent means clicking Connect again.
- A per-connector "error" status clears on the next successful connect.


## W2c · Harden (started 2026-11-05 16:54 Asia/Saigon)

Backup: `/workspace/sable-backup-pre-w2c-202611050953.tgz`

Checklist:
- [x] 1. Canvas: iframe cannot navigate its own frame / top (sandbox + CSP + navigation guard); revocable, expiring, read-only owner share links
- [ ] 2. Agent media tool (image gen via media module; approval + budget)
- [ ] 3. Morning brief as a real routine (no private timer)
- [ ] 4. Plan traces labelled by real initiator (owner vs agent)
- [ ] 5. Live HTTP test: routine-initiated approval rejected
- [ ] 6. Pending OAuth sign-ins persisted across restart (encrypted, 10-min TTL)
- [ ] 7. Triage eval on a separate 60-item held-out set (honest score)
- [ ] 8. Hardening: rate limits, body size limits, CSRF/origin checks, npm audit, memory footprint
- [ ] 9. eval:w2c + all evals; tsc; npm test; restart; ngrok 401/200; package CLEAN
