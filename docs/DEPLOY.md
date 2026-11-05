# Deploy Sable headless (24/7)

Sable is a single-operator desk agent. Run **one process** that owns `$SABLE_DATA_DIR`
(default `/workspace/sable-data`). That process hosts the UI/API on `:8080`, the
background job/routine scheduler, Telegram long-poll, SMTP notify, and the webhook
channel. Do not run two servers against the same data dir.

## Quick start (this box)

```sh
cd /workspace/sable
# secrets in .env.local (never commit)
npm run headless:start          # watchdog + vite dev on :8080
npm run headless:status
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
npm run headless:stop
```

The watchdog (`scripts/headless.mjs`) restarts the child on crash with backoff,
logs to `.grok/headless.log`, and expects `/api/jobs` to answer (200 or basic-auth
401). Jobs/channels boot via the existing `jobsBootPlugin` ping — no browser needed.

Env overrides:

| Var | Default | Meaning |
|-----|---------|---------|
| `SABLE_PORT` | `8080` | Listen port (must match Vite) |
| `SABLE_HEADLESS_CMD` / `SABLE_HEADLESS_ARGS` | `npm` / `run dev` | Child command |
| `SABLE_HEADLESS_PING` | `http://127.0.0.1:$PORT/api/jobs` | Health URL |
| `SABLE_PUBLIC=1` | set by headless | Disables Vite HMR websocket (tunnel-friendly) |

## Production build (optional)

```sh
npm run build
# Serve the Nitro/Vercel output with your host's Node adapter, **or** keep using
# `npm run dev` under the headless watchdog (supported on this box).
```

Nitro is configured with `preset: "vercel"` for deploy targets that expect that
layout. For a plain Node host, prefer the headless `vite dev` path above unless
you wire a custom Nitro `node-server` preset.

## systemd (example)

```ini
# /etc/systemd/system/sable.service
[Unit]
Description=Sable headless desk agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sable
EnvironmentFile=/opt/sable/.env.local
ExecStart=/usr/bin/node scripts/headless.mjs run
Restart=always
RestartSec=5
User=sable
# One data dir owner only:
Environment=SABLE_DATA_DIR=/var/lib/sable

[Install]
WantedBy=multi-user.target
```

`headless.mjs run` is the foreground watchdog (use this under systemd).  
`headless.mjs start` detaches a watchdog (handy on the box).

## ngrok / public tunnel

1. Set `SABLE_PASSWORD` (HTTP basic) and optionally Better Auth.
2. `SABLE_TRUSTED_ORIGINS=https://your-subdomain.ngrok-free.dev`
3. Tunnel to `http://127.0.0.1:8080`.
4. Expect **401** without credentials, **200** with `-u sable:$SABLE_PASSWORD`.
5. Webhook: `POST /api/channels/webhook` still behind basic auth; HMAC is additional
   (see `docs/WEBHOOK-API.md`).

## Kill switches (safe defaults)

| Switch | Effect |
|--------|--------|
| `SABLE_JOBS=0` | No background jobs/routines |
| `SABLE_CHANNELS=0` | Telegram / SMTP / webhook off |
| `SABLE_TELEGRAM_*` unset | Telegram off |
| `SABLE_WEBHOOK=0` / no secret | Webhook off |
| `SABLE_SHELL=0` / `SABLE_BROWSER=0` / `SABLE_VOICE=0` / `SABLE_PROFILES=0` | Feature off |
| `SABLE_SPAWN=0` / `SABLE_SKILLS=0` / `SABLE_MEMORY=0` | As named |

## Data & secrets

* `$SABLE_DATA_DIR` — jobs, inbox, memory, desk, mcp, profiles, telegram offset (mode 0700/0600).
* Workspace jail for `fs_*` / shell / browser is separate (`workspaceDir`).
* Never put API keys in the workspace the agent can `fs_read`.
* Backup: tar `$SABLE_DATA_DIR` + your `.env.local` offline.

## Health checklist

```sh
curl -s http://127.0.0.1:8080/api/jobs | head
curl -s http://127.0.0.1:8080/api/channels | head
curl -s http://127.0.0.1:8080/api/voice
curl -s http://127.0.0.1:8080/api/profiles | head
npm run headless:status
```

Telegram / routines keep running as long as this one process is up — that is the
24/7 contract.

## Phase 6 W0 — suspend resilience + vault + router/scope

### Heartbeat / catch-up after box suspend

* `POST /api/health` stamps `heartbeat.json` under `$SABLE_DATA_DIR`.
* A gap ≥ 90s marks `wokeFromSuspend`; job service logs the wake and the routine
  scheduler still fires **at most one** catch-up per routine (`planDue`).
* Kill switch: `SABLE_CATCHUP=0` (alias of `SABLE_ROUTINE_CATCHUP=0`) disables catch-up.
* `/home/box/bin/sable-watchdog.sh` restarts Sable via `startup.sh`, ticks `/api/health`,
  and keeps ngrok answering **401** (no auth) / **200** (basic auth).

### Secrets vault (skeleton)

* Encrypted store: `$SABLE_DATA_DIR/vault.json` (mode 0600).
* Master key: `SABLE_VAULT_KEY` (passphrase or 32-byte base64).
* Kill switch: `SABLE_VAULT=0`.
* API: `GET /api/vault` lists **names only**; `POST` actions `put|get|delete|has`.
* Optional migrate: copy provider keys from `.env.local` into the vault; keep
  `.env.local` for bootstrap (`SABLE_VAULT_KEY`, process env still works).

### Router / ScopeGate / tool-index / field-journal

| Switch | Effect |
|--------|--------|
| `SABLE_ROUTER=0` | Disable 3-axis skill router (`/api/router`) |
| `SABLE_SCOPE=0` | **Fail-closed**: deny all ACT that require scope |
| `SABLE_TOOLINDEX=0` | Disable PATH scan / install proposals |
| (memory) `SABLE_MEMORY=0` | field-journal writes refused |

Router config: `skills/routing.json` (benign skills only). Attribution: `skills/_meta/NOTICE-reverse-skill.md`.
Scope records: `$SABLE_DATA_DIR/scopes.json` — owner approve/deny via `/api/scope`.
Background jobs never bypass ScopeGate.

## W1 · Planner / workspace / budget / ScopeGate UI

- `SABLE_PLANNER=0` disables creating/running task graphs.
- `SABLE_WORKSPACES=0` falls back to the shared `SABLE_WORKSPACE` jail (no per-task dirs).
- Task workspaces live under `/workspace/sable-workspace/tasks/<id>/` (`SABLE_TASK_WORKSPACE_ROOT` override). Deleting a task wipes its workspace.
- `SABLE_BUDGET=0` keeps metering but does not fail-closed on caps. Caps: `SABLE_BUDGET_MAX_TOKENS`, `SABLE_BUDGET_MAX_USD`.
- Model router (D8): `SABLE_MODEL_HARD` (default `grok-4.7`), `SABLE_MODEL_LIGHT` / `SABLE_MODEL_CHEAP` for light steps; `SABLE_MODEL_ROUTER=0` always uses hard.
- ScopeGate pending scopes appear as Đồng ý/Từ chối cards (desk + background). `POST /api/tools` with `{id, approve, kind:"scope"}` or `POST /api/scope` approve/deny.
- APIs: `GET|POST /api/tasks`, `GET /api/budget`.
