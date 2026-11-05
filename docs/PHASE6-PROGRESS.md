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
- [x] 2. Agent media tool (image gen via media module; approval + budget)
- [x] 3. Morning brief as a real routine (no private timer)
- [x] 4. Plan traces labelled by real initiator (owner vs agent)
- [x] 5. Live HTTP test: routine-initiated approval rejected
- [x] 6. Pending OAuth sign-ins persisted across restart (encrypted, 10-min TTL)
- [x] 7. Triage eval on a separate 60-item held-out set (honest score)
- [x] 8. Hardening: rate limits, body size limits, CSRF/origin checks, npm audit, memory footprint
- [x] 9. eval:w2c + all evals; tsc; npm test; restart; ngrok 401/200; package CLEAN

### W2c item 8 — hardening (notes)
- `src/server/harden.ts` + Vite `hardenPlugin()` (first middleware, /api/* and /s/* only): per-IP fixed-window rate limits (read 600/min, write 120/min, share 60/min; loopback w/o XFF exempt), Content-Length cap 10 MB → 413, CSRF/origin check on POST/PUT/PATCH/DELETE /api/* → 403 (allowed: SABLE_TRUSTED_ORIGINS, localhost, same Host; `null` origin rejected; X-Forwarded-Host ignored). Exempt (secret-authenticated): `/api/channels/webhook`, `/api/routines/<id>/fire`. Kill switches: SABLE_RATE=0, SABLE_CSRF=0.
- Live: evil Origin POST → 403 (local + via ngrok), same-origin ngrok POST passes guard, 20 MB Content-Length → 413, /s/* 61st req/min → 429, /api/health 200.
- Gap: guard is a dev-server (Vite) middleware; not wired into a Nitro production build (Sable runs as `vite dev`).
- npm audit: `npm audit fix` (non-breaking) applied → zod 4.6.7, seroval 1.7.7 (fixes 1 high + 1 moderate). Remaining 11: nodemailer ≤10.1.3 (high; fix = v10 major — not applied; SMTP only talks to owner-configured server), better-auth 1.6.x (critical/high: magic-link, oauth-proxy, device-auth advisories — those plugins are NOT used; only bearer+genericOAuth; 1.7.17 tried and reverted: breaks `genericOAuthClient` / `signInWithOAuth2` APIs), typescript-eslint/minimatch (dev-only, moderate), drizzle/kysely adapters (low).
- Memory: 16 GB total, ~8.4 GB available at check; vite dev RSS ≈ 1.75 GB (the only large Sable process). No action needed.

### W2c verification (2026-11-05 ~17:25 Asia/Saigon)
- `tsc --noEmit` clean. `npm test`: script suites 197/197, TS suites 336/336 (now includes canvas/shares, media/tool, server/harden).
- Evals: w0, w1, w2 (10), w2a (11), w2b (15) pass; **eval:w2c 12/12** — offline: canvas guard + share links, media tool approval/budget, builtin brief routine, plan initiator traces, OAuth pending persistence, harden; triage tuning set gate; held-out honest score reported (rules+heuristic 65.0%, not gated; approval recall 100%). Live: builtin:morning-brief listed and undeletable, routine-webhook approval → 401 wrong secret / 403 right secret + `approval.denied_policy` audited (temp routine deleted), share link create → view (CSP frame-ancestors none, sandbox allow-scripts, target=_top stripped) → revoke → 404, CSRF 403 (evil + null origin), 20 MB body → 413.
- Restart (watchdog): local /api/health 200; eval:w2c live 12/12 again; ngrok 401 without auth, 200 with auth.
- Package: `/workspace/sable-source-w2c-202611051024.tgz` (secret scan below).

Incidents / bugs fixed in W2c:
- Box restore (~17:00 Asia/Saigon): node_modules missing, server down, uncommitted item-2 work lost → `npm ci`, item 2 rewritten, watchdog relaunched. Committing per item limited the loss to one item.
- Builtin brief could be recorded as missed at boot (first tick before module load) → `builtinReady` gate.
- Stale expired OAuth pending blob was not removed → resave on load.
- Same-origin CSRF check initially trusted X-Forwarded-Host → Host only.

Gaps / for He:
- Share links still sit behind ngrok basic auth (traffic policy unchanged) — recipients need the password unless He opts to exempt `/s/*` (docs/CANVAS-SHARE.md).
- Production triage tier is rules+heuristic (65% on held-out). Setting `SABLE_MODEL_LIGHT` (grok-4.5 tier scored 93.3%) is recommended.
- harden middleware is dev-server (Vite) only; not wired into a Nitro production build.
- npm audit residue (11): nodemailer (high, major bump needed), better-auth 1.6 (critical/high advisories for magic-link / oauth-proxy / device-auth plugins, not used here; 1.7 breaks APIs), typescript-eslint/minimatch (dev-only), adapters (low).
- Item-5 live test uses a non-existent approval id (policy denies before lookup; routines cannot create approvals at all).
- Secret scan of `sable-source-w2c-202611051024.tgz` (524 files): no `.env*`, ngrok config, vault data, DB, or key files. The key-pattern scan (xai-/sk-/ghp_/github_pat_/GOCSPX-/ya29./refresh/AKIA/private key/ngrok token, plus `SABLE_PASSWORD|XAI_API_KEY|SABLE_VAULT_KEY|authtoken = <value>`) found only test fixtures (vault.test passphrases, the eval-w0 passphrase, the eval-w2 redaction fixture) → **CLEAN by pattern**. The comparison against the live process-env values was not run: its approval card expired with no answer, so it was not retried.
- Resumed after a box suspend (~17:54 Asia/Saigon). Nothing was uncommitted. Re-verified at 17:57: tsc clean, npm test 197 + 336, evals w0..w2c pass, restart OK, ngrok 401/200.


## W3 · Desktop computer-use agent (started 2026-11-05 17:58 Asia/Saigon)

Backup: `/workspace/sable-backup-pre-w3-202611051057.tgz`

Defaults: D1 dedicated Xvfb `:99` only (other displays never touched); D2 every click/type/key/scroll needs an owner approval card (screenshot + intended action); screenshot/wait need none; background initiators (routine/trigger/agent/subagent) can never get a desktop action approved; D7 ≤2 heavy agents at once.

Checklist:
- [x] 1. Desktop session manager: Xvfb :99 + WM + Chrome (own profile under sable-data, jailed in bwrap, egress via SSRF-guard proxy) + x11vnc (localhost) + noVNC behind Sable auth; SABLE_DESKTOP kill switch; idle auto-stop
  - Files: `src/lib/agent/desktop/{config,proxy,session}.ts`, `src/server/desktop.server.ts`, `src/server/desktop-ws.ts` (WS upgrade wired in vite `hardenPlugin`), routes `/api/desktop` (GET status, POST start/stop), `/api/desktop/novnc/*` (static /usr/share/novnc, traversal guard, CSP frame-ancestors 'self').
  - Verified live: start ≈0.6 s; x11vnc 127.0.0.1:5999 + websockify 127.0.0.1:6099 only; WS upgrade 403 without/with foreign Origin, 101 same-origin (local + ngrok with auth), ngrok 401 without auth; stop removes all procs and /tmp/.X99-lock.
- [x] 2. Tools desktop_screenshot/click/type/key/scroll/wait (xdotool, bounds, secret text never logged, redaction)
  - `src/lib/agent/desktop/{actions,tools,vision}.ts`; server `desktopToolsFor("chat")` (only interactive chat; jobs/routines get none); `/api/desktop/shot/<id>` (ring of 40, no-store). Approval asks carry `image`+`mark` (card renders screenshot + red target); `canDecide(..., tool)` — desktop asks decidable only by owner web, never when the ask chain has a background initiator. Typed text via `xdotool type --file -` (stdin), secret text redacted in labels/cards/audit. Unit tests `src/lib/agent/desktop/desktop.test.ts` (13).
- [x] 3. Vision loop (screenshot → grok-4.7 proposes → approval card → execute → verify; step cap + budget; heavy-slot limit)
  - `src/lib/agent/desktop/{agent,heavy}.ts` (pure), server `startRun/cancelRun/decideDesktop`, POST `/api/desktop` actions run|cancel|decide. Budget scope "desktop" (per-run cap `SABLE_DESKTOP_RUN_USD`, default $0.5, + global meter check before each model call). Heavy slots (≤2) shared with spawned subagents (spawn waits ≤30 s then refuses).
  - Live (local test page, grok-4.7): 4 steps, 3 owner approvals, page turned green, done, $0.036.
- [x] 4. UI: Desktop panel (live view, pending action card, Stop)
  - `src/components/sable/desktop-panel.tsx` (tab "Desktop" in Chạy nền): status, Bật/Dừng, live noVNC iframe (view-only; "Tôi tự điều khiển" toggles take-over), pending action cards (screenshot + red mark, Đồng ý/Từ chối), goal → Chạy / Dừng agent, run steps + cost. Chat approval cards also render the screenshot (`desktop-shot.tsx`). noVNC inline script allowed by CSP sha256 hash (no unsafe-inline); WS path fixed to absolute `/api/desktop/vnc`.
  - Own stale `/tmp/.X99-lock` (pid recorded in our pids.json) is cleared; Xvfb gets SIGTERM on server exit. Chrome crash-restore bubble disabled.
  - Verified with headless Chrome: noVNC "Connected … :99", pending card screenshot, approve click → run done (page green).
- [x] 5. Tests: unit + E2E on :99 with a local test page; eval:w3; full verification; package CLEAN
  - Fixes: egress proxy close() now destroys CONNECT tunnels + bounded 1.5 s (stop() was wedged in "stopping"); session.stop() races proxy close vs 2 s; activeWindowTitle fallback when no WM; eval page button turns green + "Done" so the vision model can see success; POST screenshot action.
  - Results: tsc clean; npm test 197 + 356 pass, 0 fail; eval:w3 11/11 (lib E2E on :99 click/type-secret/Return/title + ≥2 egress blocks; live start localhost-only VNC, noVNC CSP, WS Origin gate + RFB banner, screenshot no approval, decide 404, vision run 2 steps / 1 owner approval / $0.017, stop, displays :1/:2 untouched); evals w0, w1, w2, w2a, w2b, w2c all pass; restart OK; ngrok / and /api/desktop 401 without auth, 200 with.
  - Memory footprint: desktop stopped = 0 extra processes (Vite ~850 MB RSS baseline). Desktop running during a vision run = 17 processes, ~1.2 GB RSS summed (Xvfb ~73 MB, x11vnc ~20 MB, websockify ~38 MB, Chrome main ~240 MB + renderer/GPU/utility children; xfwm4 ~86 MB when a WM is used). Idle auto-stop after 10 min (timer, not exercised live in eval).

**W3 package:** `/workspace/sable-source-w3-202611051143.tgz` (14.7 MB) — key-pattern secret scan CLEAN (only known fixtures: vault.test "test-master…" passphrase, evals/sable.jsonl `sk-proj-abcdefghij…` alphabet fixture); no suspicious filenames. Live-value scan not run (expired approval, not retried). W3 complete — W4 not started.

## W4 — Deep research + code worktree agent

Backup: `/workspace/sable-backup-pre-w4-202611051144.tgz`. Sole builder. Defaults: D6 GitHub PR off; D7 ≤2 heavy agents (research/code runs share slots with desktop runs + subagents). Kill switches `SABLE_RESEARCH=0`, `SABLE_CODEAGENT=0`.

- [x] 1. Deep-research agent: plan → parallel search/fetch (SSRF-guarded http_fetch) → dedupe + credibility notes → claim-level citations (quote must be in a fetched excerpt) → verifier flags unsupported claims → Canvas page; resumable checkpoints; run $ cap `SABLE_RESEARCH_RUN_USD` + step cap; heavy slot
  - `src/lib/agent/research/{config,sources,cite,pipeline,llm,fetcher,fixture}.ts`, `src/server/research.server.ts`, `/api/research` (GET status/list, `?id=` run; POST start | resume | cancel | delete), `skills/research-deep/SKILL.md`.
  - Search = xAI server-side `web_search` (model `SABLE_RESEARCH_SEARCH_MODEL`, default grok-4.5); only URLs the provider *cited* become sources. Every page is then fetched by Sable through the existing `http_fetch` SSRF guard (private/loopback/metadata blocked on every redirect hop).
  - Dedupe: URL canonicalisation (www, fragment, utm/fbclid, sorted query) + ≤2 per host + near-duplicate content (mirrors). Credibility notes are transparent heuristics (institutional TLD, reference publisher, UGC, HTTPS, thin page, visible date) — 0..5.
  - Citations: the model writes atomic claims citing `S<n>` + a verbatim quote. Verifier: quote must be found in the fetched text (normalised), unknown/unfetched source → dropped; quote whose surrounding sentence is an embedded instruction (prompt injection) → dropped; numbers not in the excerpt / low overlap → "weak"; then a model judge that can only downgrade. Unsupported claims are rendered without any link + flagged.
  - Checkpoints per step in `sable-data/research/<id>.json` (0600) — plan/search(per query)/fetch(per source)/synthesize/verify/publish; a run interrupted by restart boots as `paused`; resume skips finished work. Caps: `SABLE_RESEARCH_RUN_USD` (default $0.50, parallel calls reserve their estimate), `SABLE_RESEARCH_MAX_STEPS` (40 ops), max sources 8, queries 3; global meter scope `research`. Heavy slot (D7) per run. Provider calls: 120 s timeout + one retry.
  - Unit 10/10 (fixture site; SSRF redirect→127.0.0.1 + 169.254.169.254 blocked; injection quote dropped; resume without re-search/fetch; budget/step/global caps; reservation). Live (real web, owner-started from API): 3 queries → 8 sources (1×403) → 16 claims, 26/26 cites verbatim, 14 supported + 2 weak (judge), $0.205; resume after a failed synth step continued from checkpoint. Default model grok-4.5 (grok-4.7 JSON synth hung >270 s).
- [x] 2. Code worktree agent: git worktree under `/workspace/sable-workspace/code/<task>/` (fs jail), commands in bwrap (no network), diff + test results for review; apply/merge only with owner approval; PR off (D6)
  - `src/lib/agent/code/`: config (kill switch `SABLE_CODEAGENT=0`, `SABLE_CODE_REPOS` default /workspace, protected: reverse-skill-research, openduet-research, data dir, workspace, /home, /root, /etc; `SABLE_CODE_RUN_USD` 0.5, 20 steps, 60 s/cmd, model grok-4.5), jail (relative paths only, realpath + symlink checks, `.git` off limits, 200 KB caps), loop (one JSON action/step: list/read/write/run/done; outputs fed back as untrusted data), worktree (git with minimal env + empty HOME, no system config, hooks → /dev/null, no gpg, `protocol.allow=never`; worktree ops pin `--git-dir/--work-tree` recorded at creation), sandbox (shell_run bwrap `--unshare-all --clearenv` + worktree `.git` bound read-only, HOME=/tmp, PATH incl. /usr/local/bin; no network — package-registry egress not needed, left off), task (lifecycle).
  - Flow: start → `git worktree add -b sable/<id>` → agent loop → `add -A` + diff vs base (400 KB cap) → owner's test command in the sandbox (side effects reset to the snapshot) → status `review`. Apply (owner only; `canDecide(..., "code.apply")` = owner web UI, never a background chain) → repo must be on a branch + clean → commit in worktree → local `merge --no-ff` (conflict → `merge --abort`, repo unchanged) → worktree + branch removed. Reject → worktree + branch removed. Never pushes; `pr: "off (D6)"`.
  - Server `src/server/code.server.ts` (store `sable-data/code/<id>.json` 0600, heavy slot per task (D7), budget scope "code", audit `code.run` / `approval.decided code.apply`, restart → interrupted tasks marked failed) + route `/api/code` (GET status/list/`?id`; POST start/cancel/apply/reject/delete).
  - `code.test.ts` 10 tests (fixture repo, fake LLM): jail escapes, repo validation, sandbox (no net, ro .git, no env leak, host fs hidden), fix → review → apply, dirty/conflict refusal, reject cleanup, caps, policy. skills.test updated for the shipped `research-deep` skill.
  - Live: temp fixture repo, task 3d7aa0633c9e (4 steps, $0.009) fixed `add`, tests 2/2, applied via owner POST → merged into main; task 092276d88df8 (6 steps, $0.017) added `sub` + test → rejected → worktree/branch removed; protected repos refused. Temp repo deleted.
- [x] 3. UI: Research + Code panels (plan, progress, sources, diff viewer, approve/reject)
  - `src/components/sable/research-panel.tsx` (tab "Research"): start box, run list (status, $, supported/claims), run detail: steps with status, plan (subquestions + queries), sources with fetch status / HTTP errors / credibility score + notes, verified claims coloured by verdict with valid [S#] refs + verifier notes, stats, log, Stop / Resume / Open report (Canvas) / Delete. Polls 3 s.
  - `src/components/sable/code-panel.tsx` (tab "Code"): start form (repo, goal, test cmd), task list, task detail: summary, steps (run outputs), test log pass/fail, changed files, `DiffView` (text-only coloured unified diff), review bar: Duyệt (apply) → explicit "Xác nhận merge" confirm, Từ chối (reject), cleanup for no_changes/failed. Header states sandbox/no network/PR off (D6).
  - Item 2 commit: c48c369. Headless Chrome check (no display used): both tabs render, research detail + code diff view shown, 0 page errors.
- [x] 4. Tests with local fixture sites + fixture repo; eval:w4; full verification; package CLEAN
  - `scripts/eval-w4.mjs` (`npm run eval:w4`, `--no-llm` skips the live model run): research + code unit suites; research E2E on the local fixture web with a dishonest model (global fetch trapped: only the fixture server reachable) → every surviving cite maps verbatim to a fetched source, 4 bad claims (fabricated quote, unknown S9, injected text, blocked metadata source) flagged unsupported; code E2E on a fixture repo (escape write, `.git` write, network probe all refused/blocked; agent/background chains cannot apply; owner apply merges, no remote); live status/caps/sandbox/PR off; CSRF 403, validation 400, protected repos refused; live code-agent run on a temp repo (task 9b978be10c96-style, ~6 steps, ~$0.015) → review → owner apply → cleanup; footprint. Commit e503274.
  - Verification (after restart): tsc clean; npm test 197 + 376 pass; eval w0, w1, w2, w2a, w2b, w2c all passed; w3 11/0/0; w4 8 pass 0 fail 0 skip. ngrok: `/`, `/api/research`, `/api/code` 401 without auth, 200 with. Memory: vite main ~0.9 GB RSS; box 16 GB total, ~5 GB available.
  - Package `/workspace/sable-source-w4-202611051224.tgz` (stamp UTC = 19:24 ICT), 569 files, key-pattern scan: 0 hits, no suspicious filenames → CLEAN.

## W5 — Local vector store, hybrid retrieval, self-eval (D4)

Backup: `/workspace/sable-backup-pre-w5-202611051225.tgz`. Sole builder. Kill switches `SABLE_VECTOR=0` (index + vector recall), `SABLE_SELFEVAL=0` (grader). Nightly regression routine default **off**. Self-eval never modifies code or prompts — proposals only, owner approves.

- [x] 1. Local vector store (lightest on RAM, under sable-data) indexing memory, journal, threads, canvas pages, research sources, workspace docs; configurable embeddings (OpenAI/xAI if available → local small model → deterministic fallback; report which ran); incremental indexing, deletion propagation, vault/secrets never indexed, redaction before embedding; kill switch `SABLE_VECTOR`
  - `src/lib/agent/vector/`: `config` (kill switch, `SABLE_EMBED_PROVIDER` auto|openai|xai|local|hash, `SABLE_EMBED_MODEL`, `SABLE_VECTOR_MAX_CHUNKS` 20000, chunk 800 chars, sync every `SABLE_VECTOR_SYNC_MIN` 10), `embed` (hash / OpenAI-compatible / optional local), `select` (auto chain + report), `chunk` (html→text, overlap chunks), `store` (flat exact-cosine store, int8-quantised rows + per-row scale; `sable-data/vector/{meta.json,vectors.bin}` atomic 0600; no ANN graph — lightest on RAM, ~0.5 KB/chunk at 512-d), `sources` (collectors), `indexer` (incremental sync).
  - Choice: pure-JS flat store over sqlite-vec / HNSW — no native module, no graph memory; exact search over ≤20k chunks is a few ms.
  - Embedder that ran: **hash-v1-512 (deterministic fallback)**. OPENAI_API_KEY absent; xAI lists no embedding models (`GET /v1/embedding-models` → empty; auto mode never calls xAI unless `SABLE_EMBED_MODEL` is set); `@huggingface/transformers` not installed (deliberately, RAM). The hash embedder = signed feature hashing of folded unigrams + bigrams + char trigrams, light stemming → lexical/fuzzy, not semantic. Changing embedder → automatic full rebuild.
  - Sources: memory (profile) + journal (`memory.json`), threads (`desk.json`, tombstoned skipped), canvas pages (latest version, text only), research report + fetched source text, workspace docs (md/txt/csv/json/html/yaml…, ≤1 MB, skips `code/` worktrees, dot-dirs, tmp, node_modules, secret-looking names `.env`/keys/credential/token/vault…, files containing private-key blocks). **Vault (`vault.json`) is never read**; audit/traces/jobs/inbox not indexed.
  - Every doc text + title passes `redactSecrets` before chunking/embedding/storing. Incremental: sha per doc → unchanged docs skipped; docs gone from their store are removed (deletion propagation); newest-first under the chunk cap.
  - Server `src/server/vector.server.ts` (singleton, single-flight sync, lazy refresh if >60 s stale, boot ticker from jobs boot), route `/api/vector` (GET status incl. which embedder ran + why others didn't; POST sync | rebuild, audited).
  - `vector.test.ts` 6 tests. Live first sync: 17 docs → 228 chunks (research 196, canvas 12, thread 19, journal 1), 2 redactions, 42 ms; index ≈ 368 KB on disk.

- [ ] 2. Hybrid retrieval (BM25 + vector + recency) for memory recall + the agent's context builder with a token budget; recall tool for the agent
- [ ] 3. Self-eval: per-run lightweight grader (light model if `SABLE_MODEL_LIGHT` else rule checks) → success/groundedness; failures → review queue in the Tasks inbox; nightly regression routine (default off) running eval suites + reporting diffs; proposals only
- [ ] 4. UI: Memory search panel + Eval dashboard
- [ ] 5. Tests, eval:w5 (retrieval quality set, honest recall@k), tsc, npm test, evals w0..w4, restart, ngrok 401/200, memory footprint; package CLEAN
