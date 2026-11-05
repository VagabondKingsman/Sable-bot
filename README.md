# Sable

Single-operator desk agent (UI + jobs + Telegram/webhook) — source for
[`VagabondKingsman/Sable-bot`](https://github.com/VagabondKingsman/Sable-bot).

## Documentation

| Language | Entry |
|---|---|
| **Tiếng Việt (đầy đủ)** | **[docs/vi/README.md](./docs/vi/README.md)** — giới thiệu, kiến trúc, yêu cầu, cài VPS, **[cấu hình env](./docs/vi/08-cau-hinh-env.md)**, tính năng Phase→W7, bảo mật, FAQ |
| Env template | **[.env.example](./.env.example)** → copy thành `.env.local` |
| **Handoff (VI)** | **[docs/HANDOFF-VI.md](./docs/HANDOFF-VI.md)** — bàn giao cho agent/người tiếp tục (không cần lịch sử chat) |
| English (technical) | [docs/FULL-AGENTIC-STATUS.md](./docs/FULL-AGENTIC-STATUS.md), [docs/DEPLOY.md](./docs/DEPLOY.md), [docs/PHASE6-PROGRESS.md](./docs/PHASE6-PROGRESS.md), [docs/WEBHOOK-API.md](./docs/WEBHOOK-API.md), [docs/BRIDGE-PROTOCOL.md](./docs/BRIDGE-PROTOCOL.md), [docs/OAUTH-SETUP.md](./docs/OAUTH-SETUP.md) |

## Quick start (dev)

```sh
cp .env.example .env.local && chmod 600 .env.local
# set at least one of: XAI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / LLM_API_KEY
# plus SABLE_PASSWORD + SABLE_TRUSTED_ORIGINS when exposing publicly
# full guide: docs/vi/08-cau-hinh-env.md
npm ci
npm run headless:start    # or: npm run dev
```

See [docs/vi/04-cai-dat-vps.md](./docs/vi/04-cai-dat-vps.md) for a full Ubuntu VPS walkthrough.

## License / scope notes

Personal single-user agent. No Discord/Slack channel. No RE/pentest/CTF skills.
