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
