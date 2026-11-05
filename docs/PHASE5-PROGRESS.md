# Phase 5 progress (times Asia/Saigon UTC+7)
Backup: /workspace/sable-backup-pre-phase5-202611050617.tgz
License: AIC is PolyForm Perimeter — designs studied, no AIC code copied. Fresh Sable code; OpenClaw MIT designs referenced for sandbox ideas only.
- [x] 0. Backup + git init (main), .gitignore excludes node_modules/.env*/build/logs/data. Initial commit.
- [x] 1. Sandboxed shell (bwrap): src/lib/agent/tools/{sandbox,shell}.ts; FLAG shell; UI chip opt-in; always approval; SABLE_SHELL=0. Unit 8/8. tsc clean. Commit on main.
- [~] Scope change: item 4 (Discord / Slack / webhook-out channels) DROPPED per owner. Telegram remains the only chat channel; SMTP notify stays as built. No generic channel-adapter layer beyond what Telegram already uses. Remaining order: 2 browser → 3 local models → 5 voice → 6 multi-agent profiles → 7 headless 24/7 → final regression/package.
- [~] Scope correction: item 4 = Telegram (existing) + webhook channel only (inbound/outbound, per-channel secret/HMAC, owner-only, rate-limited, SSRF-guarded outbound URLs, versioned JSON event schema for a future Sable web app, docs/WEBHOOK-API.md). Still no Discord/Slack. Thin shared adapter with Telegram is fine. Order unchanged: 2 → 3 → 4(webhook) → 5 → 6 → 7 → final.
- [x] 2. Browser tool — `browser` (Playwright/Chromium): navigate/text/screenshot (no approval) + click/type/press/select/submit (runtime approval; background never auto-approves). SSRF via shared checkUrl before launch and after redirects; SABLE_FETCH_FAKE_IP honored; screenshots under workspace `.sable-browser/`. Kill switch SABLE_BROWSER=0. UI chip opt-in. Unit 5/5 (incl. live Chromium on local mock with injected allow).
- [x] 3. Local models — provider.ts: `ollama` (OLLAMA_BASE_URL default :11434 when OLLAMA_MODELS set; key optional → "ollama"; SABLE_OLLAMA=0) and `local` (LOCAL_BASE_URL / LOCAL_MODELS / LOCAL_API_KEY for LM Studio, vLLM, llama.cpp). Chat-style OpenAI-compatible; tool calling uses existing chatAdapter. No model weights installed. Unit +4; live smoke vs local mock :18999 (tool call → LOCAL OK). LLM_* path unchanged.

- [x] 4. Channels — Telegram (existing) + webhook only (no Discord/Slack). `src/lib/agent/channels/{types,webhook}.ts`: ChannelAdapter, HMAC-SHA256 (`X-Sable-Signature: sha256=`), owner peerId gate, RateLimiter, SSRF via checkUrl on outbound, schema v=1 events (message.in/out, job.result, job.approval, approval.response, ping/pong). Wired in channels.server (JobOrigin webhook, notify modes, inbox enqueue); `POST /api/channels/webhook`; `docs/WEBHOOK-API.md`. Kill switch SABLE_WEBHOOK=0. Unit tests in channels.test.ts (local mocks).
- [x] 5. Voice STT/TTS — OpenAI-compatible `/v1/audio/transcriptions` + `/v1/audio/speech` via VOICE_* (fallback OPENAI_*). `src/lib/agent/voice.ts`, `src/server/voice.server.ts`, `POST/GET /api/voice`, desk mic + Đọc to. Kill switch SABLE_VOICE=0; rate-limited; no key leakage. Unit tests vs local mock.
- [x] 6. Multi-agent profiles — `src/lib/agent/profiles.ts` builtins (sable/research/writer/coder) + customs in dataDir/profiles.json; Settings panel; activate applies instructions/tools; spawn_agent resolves custom ids via spawnTools; SABLE_PROFILES=0. Unit tests.
- [x] 7. Headless 24/7 + DEPLOY.md — `scripts/headless.mjs` watchdog (start/stop/status/restart, crash backoff, /api/jobs ping), npm `headless:*`, `docs/DEPLOY.md` (systemd, ngrok, kill switches, data dir). Jobs already auto-boot via jobsBootPlugin.
- [x] Final · unit regression (phase5 modules): 50/50 pass; tsc clean.
- [x] Item 1 confirm: commit `7668981` feat(phase5): sandboxed shell_run via bubblewrap — mechanism = bubblewrap (`bwrap`) jail (unshare-all, workspace RW bind only; `.env` / sable-data / home not mounted; network off unless approved); fallback cwd-jail if bwrap missing.
- [x] Full verification (Asia/Saigon 2026-11-05 ~14:00):
  - Unit: scripts **197/197** + src **246/246** (was 245; +1 webhook replay).
  - Eval: **29/29** (22 prior + shell approval reject/approve, browser click reject, webhook HMAC bad/ok, profile research/coder allowlists). Harness extended for shell_run/browser/webhook/profile cats.
  - E2E phase1–4 (:8091 + mocks): deep-live **33/34** (known httpbin 403 on SSRF-redirect; unit covers redirect SSRF), p3-live **44/44**, p3-expiry **2/2**, p4-spawn **17/17**, p4-skills **18/18**, p4-mcp **22/22**, p4-triggers **27/27** (needs `SABLE_WATCH_TICK_S=5`), ui-deep **18/18**, ui-desk **20/20**, ui-mem **12/12**, ui-jobs **27/27**, ui-triggers **5/5**, ui2 **11/11**.
  - Phase5 live (:8091): **19/19** — shell approval+bwrap jail denies `.env.local`/sable-data/passwd; browser SSRF 127.0.0.1 + 169.254.169.254; browser click approval reject; webhook bad sig 401 / good 200 / replay 409; voice status; profiles activate research→sable. Voice kill `SABLE_VOICE=0` → enabled:false. Headless start → `/api/jobs` 200 → stop OK.
- [x] Bugs fixed this verification pass:
  1. Webhook **replay**: same event `id` now returns **409** (in-process seenIds, ~10 min TTL). Docs + unit test.
  2. Tool step **detail** now includes clipped successful tool output (so shell jail markers appear in job traces).
  3. Eval harness + 7 new cases; scrub redact fixture.
- [x] Final · restart :8080; ngrok **401** without auth / **200** with basic auth; local 200; sable-watchdog + ngrok still running.
- [x] Final · package + secret scan (see report below).
- Package: /workspace/sable-source-phase5-202611050703.tgz
