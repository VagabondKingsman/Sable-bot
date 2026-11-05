# Sable — Phase 3 setup: learned memory, Telegram, email

Everything here is **off-by-default for channels** and **owner-only**. Secrets go in
`.env.local` (never committed, never printed). Restart Sable after changing env
(`SABLE_PUBLIC=1` has no hot reload).

## 1. Learned memory (on by default)

Sable learns lasting facts from your chats (after each reply, one short model call)
and injects the relevant ones (≈3,000 chars max) into later prompts.

| Where | Can read | Can write |
|---|---|---|
| Interactive chat | ✅ | ✅ (auto-extract, `memory_save`, `memory_forget`) |
| Chat with "Không ghi nhớ cuộc trò chuyện này" ticked | ✅ | ❌ |
| Background jobs, routines, Telegram jobs | ✅ (`memory_recall`) | ❌ |

* Manage it in **Cách Sable làm việc → Sable tự ghi nhớ**: search, add, edit, pin,
  delete, delete all, export/import JSON, on/off switch.
* Secrets are never stored: API keys, tokens, JWTs, private keys, card numbers
  (Luhn), URL credentials and "password/mật khẩu/OTP/PIN: …" are masked before
  the extractor model sees the text, and facts about credentials are dropped.
* Stored in `$SABLE_DATA_DIR/memory.json` (mode 0600; default `/workspace/sable-data`).
  Cap 500 items (journal evicted first), unpinned journal entries expire after 365 days.

| Env | Default | Meaning |
|---|---|---|
| `SABLE_MEMORY=0` | on | Kill switch: no injection, no tools, no learning (overrides UI) |
| `SABLE_MEMORY_MODEL` | chat model | Cheaper model id for extraction |
| `SABLE_MEMORY_MAX` | 500 | Item cap |
| `SABLE_MEMORY_JOURNAL_DAYS` | 365 | Journal retention |

## 2. Telegram (long-poll, no webhook, nothing exposed)

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the bot token.
2. Find your numeric user id (e.g. message **@userinfobot**).
3. Add to `.env.local`:
   ```sh
   SABLE_TELEGRAM_TOKEN=<token from BotFather>
   SABLE_TELEGRAM_OWNER_IDS=<your numeric id>   # comma-separated for several of your own accounts
   ```
4. Restart Sable, open the UI once (channels start with the job service), check
   `GET /api/channels` → `telegram.running: true`.
5. Message your bot in a **private chat**. `/help`, `/new` (fresh context), `/status`.

Behaviour:
* Only private chats whose user id is in `SABLE_TELEGRAM_OWNER_IDS` are handled;
  everyone else (and every group) is dropped silently — no reply, no content logged.
* Each message becomes a background job (same limits, fs jail, SSRF guards,
  `SABLE_TOOLS` kill switch). The answer is sent back to that chat only.
* File writes ask for approval with **✅ Duyệt / ❌ Từ chối** buttons. Only the chat
  the card was sent to can press them. No answer before the approval TTL
  (`SABLE_JOB_APPROVAL_TTL_H`, default 24 h) = rejected; the card is edited to say so.
  The same approval also appears in the Sable inbox.
* The token is never logged or returned by any API; errors are scrubbed.
* Messages older than 10 min (backlog after downtime) are ignored; the last update
  id is kept in `$SABLE_DATA_DIR/telegram.json` so restarts don't replay.

| Env | Default | Meaning |
|---|---|---|
| `SABLE_TELEGRAM_MODEL` | first available model | Model for Telegram jobs |
| `SABLE_TELEGRAM_TOOLS` | `files,fetch` | Also `web`, `x` (xAI only) |
| `SABLE_TELEGRAM_NOTIFY` | `own` | `all` = also send results/approvals of UI jobs & routines to the first owner id; `off` |
| `SABLE_TELEGRAM_RATE` | 20 | Max jobs per 10 min |
| `SABLE_TELEGRAM_API_BASE` | `https://api.telegram.org` | Only for testing against a mock |

## 3. Email notifications (SMTP)

Mail goes to **exactly one** address you configure; nothing the model writes can
change the recipient. Subjects/bodies are redacted; approvals are never done by
email (the mail says to open Sable).

```sh
SABLE_SMTP_HOST=smtp.gmail.com
SABLE_SMTP_PORT=587            # 465 → implicit TLS; 587 → STARTTLS required
SABLE_SMTP_USER=you@gmail.com
SABLE_SMTP_PASS=<app password> # Gmail: Google Account → Security → App passwords
SABLE_SMTP_FROM=you@gmail.com
SABLE_SMTP_TO=you@gmail.com    # one address only
SABLE_SMTP_NOTIFY=own          # own = routine results + routine approvals; all = every job; off
```
`SABLE_SMTP_ALLOW_INSECURE=1` allows plain SMTP — only for a local relay/mock.

## 4. Kill switches & status

* `SABLE_CHANNELS=0` — Telegram and SMTP off.
* `SABLE_MEMORY=0` — learned memory off.
* `GET /api/channels` — running/configured, handled/dropped counts, last error
  (no tokens, masked address).

## 5. Testing locally (no real Telegram/SMTP)

`/workspace/e2e/tg-mock.mjs` (Bot API mock, :8098), `smtp-mock.mjs` (:2525, list at
:2526/_mails), `mock.mjs` (LLM, :8099) and `p3-live.mjs` / `p3-expiry.mjs` /
`ui-mem.mjs` run the Phase 3 checks against a second instance on :8091 started with
`/workspace/e2e/p3-env.sh` (fake token).
