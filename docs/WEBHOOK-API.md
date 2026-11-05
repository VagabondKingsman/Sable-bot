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
| `job.result` | ← Sable | `{ "text", "status", "title" }` |
| `job.approval` | ← Sable | `{ "text", "approvals": [{ "id", "summary", "preview?" }] }` |
| `pong` | ← Sable | ack / error |

`peerId` is required on `message.in` and `approval.response` and must equal `SABLE_WEBHOOK_OWNER`.

## Example

```bash
BODY='{"v":1,"type":"ping","id":"evt_1","at":1730000000000,"channel":"webhook","payload":{}}'
SIG=$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SABLE_WEBHOOK_SECRET" | awk '{print $2}')
curl -u sable:$SABLE_PASSWORD -H "ngrok-skip-browser-warning: 1" \
  -H "content-type: application/json" -H "X-Sable-Signature: sha256=$SIG" \
  -d "$BODY" https://…/api/channels/webhook
```
