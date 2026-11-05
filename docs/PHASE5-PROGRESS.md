# Phase 5 progress (times Asia/Saigon UTC+7)
Backup: /workspace/sable-backup-pre-phase5-202611050617.tgz
License: AIC is PolyForm Perimeter — designs studied, no AIC code copied. Fresh Sable code; OpenClaw MIT designs referenced for sandbox ideas only.
- [x] 0. Backup + git init (main), .gitignore excludes node_modules/.env*/build/logs/data. Initial commit.
- [x] 1. Sandboxed shell (bwrap): src/lib/agent/tools/{sandbox,shell}.ts; FLAG shell; UI chip opt-in; always approval; SABLE_SHELL=0. Unit 8/8. tsc clean. Commit on main.
- [~] Scope change: item 4 (Discord / Slack / webhook-out channels) DROPPED per owner. Telegram remains the only chat channel; SMTP notify stays as built. No generic channel-adapter layer beyond what Telegram already uses. Remaining order: 2 browser → 3 local models → 5 voice → 6 multi-agent profiles → 7 headless 24/7 → final regression/package.
- [~] Scope correction: item 4 = Telegram (existing) + webhook channel only (inbound/outbound, per-channel secret/HMAC, owner-only, rate-limited, SSRF-guarded outbound URLs, versioned JSON event schema for a future Sable web app, docs/WEBHOOK-API.md). Still no Discord/Slack. Thin shared adapter with Telegram is fine. Order unchanged: 2 → 3 → 4(webhook) → 5 → 6 → 7 → final.
