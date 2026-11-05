# Sable ↔ peer agent bridge — `sable.bridge.v1` (W6 / D9)

The bridge lets Sable hand a task or question to **one** configured external agent (intended: a Grok Bot
webhook routine) and receive results back. It is a signed webhook pair. This doc covers the Sable side only.

```
Sable ──POST (signed) handoff.task | handoff.question | ping──▶  peer webhook URL   (owner-approved, one card per send)
Sable ◀──POST (signed) result | message | ping ─────────────────  https://<sable-host>/api/bridge/inbound
```

## Safety model

| Rule | How |
|---|---|
| Off by default | `SABLE_BRIDGE=0` kills both directions. Otherwise the bridge is on only once a peer URL **and** a shared secret (≥ 32 chars) are configured. |
| Every outbound handoff needs the owner | Bridge panel → pending card → owner clicks **Duyệt gửi** (expires after 30 min). Chat → `bridge_handoff` tool → the normal approval card; `bridge_handoff` is owner-only in `canDecide` (Telegram / channel / background cannot approve it). |
| Background never sends | `mayStart` refuses routine, trigger, agent, subagent and channel initiators, and any initiator whose `via` chain contains a background kind. The chat tool exists only in interactive web chat (not routines, jobs, subagents, channels). |
| Payload | Known secret values (env + vault) and key patterns are redacted **before** signing; text ≤ 16 000 chars, title ≤ 200, body ≤ 64 000 bytes. The approval card shows the exact redacted payload. |
| Network | https only, URL credentials refused, SSRF guard (`checkUrl`, private/loopback refused), redirects refused, reply read ≤ 64 KB, 15 s timeout. |
| Inbound is data | Results/messages are stored as **untrusted data**: shown in Tasks (kind `bridge`, "dữ liệu không tin cậy") with state-only chips (Đã xem / Bỏ qua). They are never instructions, never approve/reject anything, never start a run, a tool, or a send. Optional (off by default): each item opens a **new** no-memory thread with an untrusted banner. |

## Message schema

```json
{
  "schema": "sable.bridge.v1",
  "id": "brg_lx2k9a_3f9c0a1b2c3d",
  "type": "handoff.task",
  "from": "sable",
  "at": 1793900000000,
  "inReplyTo": "brg_… (peer → Sable only; the Sable handoff id it answers)",
  "body": { "title": "≤200 chars", "text": "≤16000 chars", "status": "done|failed|partial", "links": ["https://…"] }
}
```

- `id`: 6–80 chars `[A-Za-z0-9_.:-]`, unique per message (reused id → 409).
- `at`: ms since epoch.
- Sable → peer types: `handoff.task`, `handoff.question`, `ping`.
- Peer → Sable types: `result`, `message`, `ping`, `pong`. Anything else → 422. Unknown fields are dropped; links that are not http(s) are dropped.

## Signing

```
signing string = "sable.bridge.v1:" + <timestamp> + ":" + <nonce> + ":" + <raw request body>
signature      = hex( HMAC-SHA256(shared_secret, signing string) )
```

Headers (both directions):

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Bridge-Timestamp` | unix **seconds**; must be within ±300 s of the receiver's clock |
| `X-Bridge-Nonce` | 16–64 chars `[A-Za-z0-9_-]`, never reused (receiver remembers nonces for 10 min) |
| `X-Bridge-Signature` | `v1=<hex signature>` (constant-time compare) |
| `Authorization` | optional, outbound only: `Bearer <BRIDGE_PEER_TOKEN>` if the peer wants a token as well |

Sign the **exact bytes** you send. Re-serialising JSON after signing breaks the signature.

## Inbound endpoint `POST /api/bridge/inbound`

Responses are JSON `{ ok, code, message? , id? }`:

| HTTP | code | Meaning |
|---|---|---|
| 202 | `accepted` | stored in Tasks inbox (and optional thread) |
| 200 | — | `ping` → body is a signed `pong` message (headers carry its signature) |
| 400 | `bad_request` | body not JSON |
| 401 | `bad_signature` | missing/malformed headers or wrong HMAC |
| 401 | `stale_timestamp` | timestamp outside ±300 s |
| 403 | `bridge_off` | `SABLE_BRIDGE=0` or not configured |
| 409 | `replay` | nonce or message id already seen |
| 413 | `too_large` | body > 64 000 bytes |
| 422 | `bad_schema` | wrong schema / type / fields |
| 429 | `rate_limited` | > 30 accepted per minute (`SABLE_BRIDGE_RATE`), or > 20 bad signatures per minute |

The peer's own endpoint should answer Sable's POST with 2xx (202 for handoffs; for `ping` it may reply 200 with
a signed `pong`, which Sable verifies). Sable never follows redirects.

### Example (peer → Sable) with curl + openssl

```bash
SECRET='<shared secret — read it from your own vault, never paste it in chat>'
BODY='{"schema":"sable.bridge.v1","id":"res_0001abcd","type":"result","from":"peer","at":'"$(date +%s000)"',"inReplyTo":"brg_lx2k9a_3f9c0a1b2c3d","body":{"title":"Xong","text":"Tóm tắt…","status":"done"}}'
TS=$(date +%s); NONCE=$(openssl rand -hex 16)
SIG=$(printf '%s' "sable.bridge.v1:$TS:$NONCE:$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')
curl -sS -X POST https://<sable-host>/api/bridge/inbound \
  -H 'Content-Type: application/json' -H "X-Bridge-Timestamp: $TS" -H "X-Bridge-Nonce: $NONCE" -H "X-Bridge-Signature: v1=$SIG" \
  --data-binary "$BODY"
unset SECRET
```

Re-running the same command → `409 replay`.

## Setup for He

1. **Vault key.** Set `SABLE_VAULT_KEY` (Sable can't store vault entries without it).
2. **Shared secret.** Generate ≥ 32 random chars (e.g. `openssl rand -base64 48`). Store it in Sable's vault as
   **`BRIDGE_SECRET`** and give the same value to the peer. Env fallback: `SABLE_BRIDGE_SECRET`.
3. **Peer URL.** Store the Grok Bot routine's webhook URL (https) in the vault as **`BRIDGE_PEER_URL`**
   (env fallback `SABLE_BRIDGE_URL`). Optional bearer token for that webhook: **`BRIDGE_PEER_TOKEN`**
   (env `SABLE_BRIDGE_PEER_TOKEN`).
4. **Grok Bot side.** It needs a webhook-triggered routine that verifies the signature above and posts results to
   `https://<sable-host>/api/bridge/inbound`. **He must create/approve that routine in Grok Bot himself**; Sable
   cannot create it. Treat whatever Sable sends as data on the Grok Bot side too.
5. **Restart** Sable, open Settings → Bridge: status should read "sẵn sàng". Use **Test ping (mock)** for a local
   self-test (no network, throwaway secret), then **Ping peer** — that creates an approval card like any handoff.
6. **Kill switch.** `SABLE_BRIDGE=0` + restart turns both directions off immediately.

### Ingress note (ngrok / VPS)

On the current ngrok tunnel, ngrok's basic auth applies to every path, so a peer calling `/api/bridge/inbound`
over ngrok also needs the basic-auth credentials. On the real VPS prefer: keep desk auth on everything **except**
`/api/bridge/inbound`, which authenticates by HMAC (it is already CSRF-exempt and rate-limited), behind TLS.
