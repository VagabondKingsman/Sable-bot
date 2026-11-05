# Sable — Full Agentic status (W0 → W6)

**As of:** 2026-11-05 ~20:15 Asia/Saigon (ICT). Detailed per-item log: `docs/PHASE6-PROGRESS.md`.
Every wave: tsc clean, `npm test` green, its own `eval:wN` green, restart, ngrok 401 (no auth) / 200 (basic auth),
source package with a clean key-pattern scan (live secret-value scan intentionally not run).

## What is live (on the box, behind desk auth)

| Wave | Feature | Kill switch | Live state now |
|---|---|---|---|
| W0 | Suspend resilience (heartbeat, catch-up, watchdog), secrets vault (AES-GCM, names-only API), 3-axis skill router, ScopeGate fail-closed, field-journal → memory, tool-index (propose only) | `SABLE_CATCHUP`, `SABLE_VAULT`, `SABLE_ROUTER`, `SABLE_SCOPE` | on; **vault cannot store** (no `SABLE_VAULT_KEY`) |
| W1 | Planner/executor task graphs + checkpoints, per-task workspaces, token/cost budget + model router, ScopeGate approval card | `SABLE_PLANNER`, `SABLE_WORKSPACES`, `SABLE_BUDGET` | on |
| W2 | Trace UI, image/video generation + media library, Canvas Pages (sandboxed) | `SABLE_TRACE`, `SABLE_MEDIA`, `SABLE_CANVAS` | on (video needs a real provider) |
| W2a | Triage, morning brief routine (default off), Tasks inbox, reply chips (never send), initiator audit | `SABLE_TRIAGE`, `SABLE_BRIEF`, `SABLE_PROACTIVE` | on; brief off by default |
| W2b | OAuth2 connectors: Gmail (read, draft, send via approval) + Google Calendar (write via approval) | `SABLE_OAUTH` | code live; **not connected** (needs Google client + vault key) |
| W2c | Hardening: canvas share links, agent media tool, rate/body limits, CSRF/origin, held-out triage eval | `SABLE_CSRF`, `SABLE_SHARE`, `SABLE_MEDIA_TOOL` | on |
| W3 | Desktop computer-use agent (Xvfb :99, bwrap-jailed Chrome, egress proxy, noVNC, approval per action) | `SABLE_DESKTOP` | on demand; idle auto-stop 10 min |
| W4 | Deep research (verified claim-level citations) + code worktree agent (bwrap, no network, apply only with approval) | `SABLE_RESEARCH`, `SABLE_CODEAGENT` | on |
| W5 | Local vector store, hybrid recall (BM25 + vector + recency), self-eval + review queue, nightly regression (off) | `SABLE_VECTOR`, `SABLE_SELFEVAL`, `SABLE_EVAL_NIGHTLY` | on, **hash embedder** (lexical) |
| W6 | Sable ↔ Grok Bot bridge `sable.bridge.v1`: signed outbound handoffs (approval per send), signed inbound `/api/bridge/inbound` (data only), Settings → Bridge panel | `SABLE_BRIDGE` | **off — unconfigured** (inbound → 403 `bridge_off`); mock self-test works |

Invariants held throughout: every outbound send / write needs an owner approval card; background initiators
(routine, trigger, agent, subagent) never approve and never send; channel (Telegram/webhook) cannot approve owner-only
tools (desktop, code apply, bridge); bwrap for shell/code/desktop; SSRF guard on fetch/outbound; Sable's env is never
passed to sandbox, desktop or eval children; secrets redacted in logs/traces/payloads; no RE/pentest/CTF content.

## Needs He's credentials / decisions

| Item | Where | Unlocks |
|---|---|---|
| `SABLE_VAULT_KEY` (long random passphrase) | env on the host (never in git) | vault storage → OAuth tokens, bridge URL/secret, other keys |
| Google OAuth client (`SABLE_GOOGLE_CLIENT_ID` / `SABLE_GOOGLE_CLIENT_SECRET`), redirect URI on the public origin | env / Google Cloud Console — `docs/OAUTH-SETUP.md` | Gmail + Calendar connectors |
| Telegram bot token + owner ids (`SABLE_TELEGRAM_TOKEN`, `SABLE_TELEGRAM_OWNER_IDS`) | env | Telegram channel + brief delivery |
| Embeddings: `OPENAI_API_KEY` (or `SABLE_EMBED_PROVIDER`/`SABLE_EMBED_MODEL`), or a local small model (`@huggingface/transformers`, more RAM) | env | real semantic recall (paraphrase R@5 is 0.42 on the hash fallback) |
| `SABLE_MODEL_LIGHT` (e.g. a grok-4.5-tier model) | env | model-tier triage (93% vs 65% rules on held-out) + self-eval grader |
| Bridge: `BRIDGE_PEER_URL`, `BRIDGE_SECRET` (≥32 chars), optional `BRIDGE_PEER_TOKEN` | Sable vault (env fallback `SABLE_BRIDGE_URL` / `SABLE_BRIDGE_SECRET` / `SABLE_BRIDGE_PEER_TOKEN`) — `docs/BRIDGE-PROTOCOL.md` | outbound handoffs + inbound results |
| Grok Bot webhook routine that verifies the signature and posts back to `/api/bridge/inbound` | Grok Bot — **He must create and approve it** | the peer side of the bridge |

## Known gaps

- Bridge: only the Sable side exists; live peer untested (no URL/secret). Over ngrok the peer also needs basic auth.
  Replay cache is in memory (a restart forgets nonces; the ±300 s window still bounds replays). One peer only.
- Vault cannot store anything until `SABLE_VAULT_KEY` is set; Google connectors untested against real Google
  (Testing-mode refresh tokens expire after 7 days); Gmail text/plain only, 2-day polling sync.
- Recall uses the hash embedder (lexical) — weak on paraphrase until a real embedding model is configured.
- Triage/grader run rules-only until `SABLE_MODEL_LIGHT` is set.
- Harden middleware (CSRF, rate, body limits) is wired into the Vite dev server only, not a Nitro production build.
- npm audit residue (nodemailer major bump, better-auth plugins not used, dev-only lint deps).
- Canvas share links and the inbound bridge sit behind ngrok basic auth on the current tunnel.
- Planner `agent` steps are partly dry-run; budget meter not hooked to every provider usage field.
- Video generation needs a real provider; canvas pages cannot load CDN assets (CSP by design).

## Pre-deploy checklist (real VPS)

1. Fresh host user, Node 22+, `bwrap`, `git`; for the desktop agent: Xvfb, x11vnc, websockify, Chrome.
2. `npm ci`, run `npx tsc --noEmit`, `npm test`, `npm run eval:w0` … `eval:w6` on the host.
3. Secrets only in the host env / secret manager (never in the repo or `.env` in git): `SABLE_PASSWORD`,
   `XAI_API_KEY`, `SABLE_VAULT_KEY`, `SABLE_WEBHOOK_SECRET`; then the optional ones above. Rotate the values used on the box.
4. `SABLE_DATA_DIR` on persistent disk, mode 0700; back it up (vault, jobs, memory, desk, bridge) — encrypted backups.
5. TLS reverse proxy (Caddy/nginx) on the public origin; desk auth on everything; exempt only HMAC machine
   endpoints if wanted (`/api/bridge/inbound`, `/api/channels/webhook`, routine fire), which authenticate themselves.
6. Wire the harden middleware (CSRF, rate, body limits) into the production server, or run behind the dev server
   as on the box; set `SABLE_TRUSTED_ORIGINS` to the public origin.
7. Register the OAuth redirect URI on the public origin; publish the Google app or accept 7-day tokens.
8. Process supervisor (systemd) with the watchdog/heartbeat, log rotation, memory limits (~1 GB base, +1.2 GB while the desktop runs).
9. Start with kill switches conservative: `SABLE_BRIDGE=0`, `SABLE_DESKTOP=0`, brief/nightly off; enable one at a time
   and confirm with each wave's eval.
10. Bridge go-live: store `BRIDGE_PEER_URL` + `BRIDGE_SECRET` in the vault, He approves the Grok Bot webhook routine,
    Settings → Bridge → Test ping (mock) → Ping peer (approve the card) → expect a verified pong.
11. Re-run the key-pattern scan on the deploy artifact; confirm ngrok/old tunnels are shut down.
