# Sable Webhook API (v1)

Machine-to-machine channel for a future Sable web app (and any owner-controlled client).
Telegram stays the human chat channel; SMTP stays notify-only. **No Discord/Slack.**

## Auth

- Shared secret: `SABLE_WEBHOOK_SECRET` (≥ 16 chars). Never logged or returned.
- Every request (in and out) signs the **raw body** with HMAC-SHA256.
- Header: `X-Sable-Signature: sha256=<hex>` (the `sha256=` prefix is optional).
- Kill switch: `SABLE_WEBHOOK=0`. Also off when `SABLE_CHANNELS=0`.

## Endpoints

### Inbound (client → Sable)

`POST /api/channels/webhook`

When exposed via ngrok, basic auth still applies in front of this route.

### Outbound (Sable → client)

Set `SABLE_WEBHOOK_URL` to an `https` URL (ports 80/443). The URL is checked with the same SSRF guards as `http_fetch` (`SABLE_FETCH_ALLOW`, private ranges blocked, no credentials in URL, redirects refused). Sable POSTs events with the same signature header.

## Env

| Var | Meaning |
|-----|---------|
| `SABLE_WEBHOOK_SECRET` | HMAC secret (required to enable) |
| `SABLE_WEBHOOK_URL` | Optional outbound URL |
| `SABLE_WEBHOOK_OWNER` | Allowed `peerId` for `message.in` / `approval.response` (default `owner`) |
| `SABLE_WEBHOOK_NOTIFY` | `own` (default) / `all` / `off` — which job results/approvals to push |
| `SABLE_WEBHOOK_RATE` | Max inbound message.in jobs per 10 min (default 30) |
| `SABLE_WEBHOOK` | `0` disables the channel |

## Event schema (`v: 1`)

```json
{
  "v": 1,
  "type": "message.in | message.out | job.result | job.approval | approval.response | ping | pong",
  "id": "evt_…",
  "at": 1730000000000,
  "channel": "webhook",
  "peerId": "owner",
  "ref": { "jobId": "job_…", "approvalId": "…", "routineId": "rtn_…" },
  "payload": { }
}
```

### Types

| type | Direction | payload |
|------|-----------|---------|
| `ping` | → Sable | `{}` → replies `pong` |
| `message.in` | → Sable | `{ "text": "…" }` enqueues a background job (`origin.channel=webhook`) |
| `approval.response` | → Sable | `{ "approvalId": "…", "approve": true\|false }` or `{ "decision": "approve\|reject" }` |
| `message.out` | ← Sable | `{ "text": "…" }` |
| `job.result` | ← Sable | `{ "text", "status", "title", "reply_to"? }` — `reply_to` echoes the inbound message it answers (W7) |
| `job.approval` | ← Sable | `{ "text", "approvals": [{ "id", "summary", "preview?" }] }` |
| `pong` | ← Sable | ack / error |

`peerId` is required on `message.in` and `approval.response` and must equal `SABLE_WEBHOOK_OWNER`.

### W7: reply threading and busy behaviour (`message.in`, all optional)

| Field | Meaning |
| --- | --- |
| `reply_to` | Your id for the message being sent (`[A-Za-z0-9_.:-]{1,120}`). Echoed as `payload.reply_to` on the `job.result` that answers it, so you can thread the reply. Default: the inbound event `id`. |
| `reply_text` | The text of the message this one quotes (≤4 000 chars). Inlined for the model as a marked, truncated "referenced message". |
| `reply_role` | `"assistant"` if the quoted text was Sable's, otherwise `"user"`. |
| `mode` | What to do while a job for this `peerId` is still running: `"steer"` (default) — the text joins the running job at its next safe point (between model/tool steps); `"queue"` — runs as a new job after the current one ends; `"new"` — start a separate job now. With no running job every mode starts a job. |

The `pong` reply carries `mode: "started" | "steered" | "queued"` and the `jobId` the message went to. Steered/queued messages are still owner messages under the same rules: approvals still go through `approval.response`, and the peer cannot approve a run its own message started. If a steered message arrives after the job's last safe point, it starts the next job automatically.

```json
{ "type": "message.in", "peerId": "owner", "payload": { "text": "Cũng kiểm tra hộp thư nhé", "reply_to": "app-msg-42", "mode": "steer" } }
```

## Example

```bash
BODY='{"v":1,"type":"ping","id":"evt_1","at":1730000000000,"channel":"webhook","payload":{}}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SABLE_WEBHOOK_SECRET" | awk '{print $2}')
curl -u sable:$SABLE_PASSWORD -H "ngrok-skip-browser-warning: 1" \
  -H "content-type: application/json" -H "X-Sable-Signature: sha256=$SIG" \
  -d "$BODY" https://…/api/channels/webhook
```

## Replay protection

Each event `id` is remembered for ~10 minutes (in-process). A second POST with the
same `id` and a valid HMAC returns **409** (`Sự kiện trùng (replay)`). Clients must
mint a fresh `id` per distinct event.
