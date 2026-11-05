# 08 · Cấu hình môi trường (`.env.local`)

Nguồn chân lý: [`.env.example`](../../.env.example) (đầy đủ mọi biến code đọc) +
`scripts/check-env-example.mjs` (fail nếu thiếu biến trong example).

## 1. Sao chép file

```sh
cd /path/to/Sable-bot   # ví dụ /opt/sable
cp .env.example .env.local
chmod 600 .env.local
# Mở bằng editor — bỏ comment (#) và điền giá trị cho các dòng cần dùng
```

`.env.local` đã nằm trong `.gitignore`. `startup.sh` / headless load bằng `set -a; . ./.env.local`.

## 2. Tối thiểu để boot có chat (3–5 biến)

| # | Biến | Bắt buộc? | Việc |
|---|---|---|---|
| 1 | `XAI_API_KEY` **hoặc** `OPENAI_API_KEY` **hoặc** `DEEPSEEK_API_KEY` **hoặc** `LLM_API_KEY` | Có (một trong bốn) | Chat/media; thiếu → UI lên nhưng 503 |
| 2 | `SABLE_PORT` | Không (mặc định `8080`) | Cổng |
| 3 | `SABLE_DATA_DIR` | Nên trên VPS | Data bền, mode 0700 |
| 4 | `SABLE_PASSWORD` | Có nếu public + basic | Auth cửa ngrok/proxy |
| 5 | `SABLE_TRUSTED_ORIGINS` | Có nếu public/OAuth | CSRF + redirect base |

Ví dụ tối thiểu local (chỉ xAI):

```sh
XAI_API_KEY=<your-xai-key>
SABLE_PORT=8080
```

Ví dụ public:

```sh
XAI_API_KEY=<your-xai-key>
SABLE_PASSWORD=<your-basic-auth-password>
SABLE_TRUSTED_ORIGINS=https://sable.example.com
SABLE_DATA_DIR=/var/lib/sable
SABLE_PUBLIC=1
```

Sau đó: `npm run headless:start` (hoặc `npm run dev`) →
`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/` kỳ vọng `200`.

## 3. Sinh secret bằng openssl

```sh
# Vault master (32 byte base64) — bắt buộc trước OAuth/bridge trong vault
openssl rand -base64 32

# Mật khẩu basic auth / webhook secret (≥16) / bridge secret (≥32)
openssl rand -base64 24    # ~32 ký tự
openssl rand -hex 32       # 64 hex

# Không in secret vào chat/log; gắn thẳng vào .env.local hoặc vault UI
```

## 4. Lấy từng loại credential

### 4.1 xAI

1. Console xAI → API keys → tạo khóa.
2. `.env.local`: `XAI_API_KEY=<your-xai-key>`
3. (Tuỳ) `XAI_MODELS`, `XAI_BASE_URL` (mặc định `https://api.x.ai`).

### 4.2 OpenAI / DeepSeek / generic LLM

- OpenAI: `OPENAI_API_KEY`, tuỳ `OPENAI_BASE_URL` (mặc định `https://api.openai.com`).
- DeepSeek: `DEEPSEEK_API_KEY`, mặc định base `https://api.deepseek.com`.
- Generic: `LLM_API_KEY` + `LLM_BASE_URL` (+ `LLM_MODELS`, `LLM_API_STYLE`).
- Ollama: cài local, `OLLAMA_MODELS=...` (base mặc định `http://127.0.0.1:11434`).
- LM Studio / vLLM: `LOCAL_BASE_URL` + `LOCAL_MODELS`.

### 4.3 Telegram (BotFather + chat id)

1. Telegram → `@BotFather` → `/newbot` → copy token → `SABLE_TELEGRAM_TOKEN`.
2. Lấy **numeric user id** (không phải @username):
   - Cách A: nhắn `@userinfobot` / `@getidsbot`.
   - Cách B (getUpdates): gửi tin cho bot của bạn, rồi:
     ```sh
     curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | head -c 2000
     # đọc result[].message.from.id
     ```
3. `SABLE_TELEGRAM_OWNER_IDS=<id>` (csv nếu nhiều tài khoản của bạn).
4. Restart; `GET /api/channels` → `telegram.running: true`. Chỉ chat **riêng**.

### 4.4 Google OAuth (Gmail + Calendar)

Chi tiết: `docs/OAUTH-SETUP.md`. Tóm tắt:

1. Có `SABLE_VAULT_KEY` (vault phải configured).
2. Google Cloud → bật Gmail API + Calendar API.
3. Consent **Testing** + test user = tài khoản của bạn.
4. Scopes code yêu cầu (đúng bốn):
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/calendar.events`
5. OAuth client **Web** → Authorized redirect URI **khớp exact**:

   `https://<domain-của-bạn>/api/oauth/callback`

   (`SABLE_OAUTH_REDIRECT_BASE` hoặc origin đầu `SABLE_TRUSTED_ORIGINS`).
6. Client id/secret → **Vault** tên `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET` (ưu tiên) hoặc env `SABLE_GOOGLE_CLIENT_*`.
7. UI **Kết nối → Connect**. Testing: refresh token hết sau **7 ngày**.

### 4.5 Webhook secret

```sh
openssl rand -base64 24   # ≥16 ký tự
# SABLE_WEBHOOK_SECRET=<...>
# Tuỳ: SABLE_WEBHOOK_URL=https://...  (SSRF-checked)
```

Ký HMAC: xem `docs/WEBHOOK-API.md`.

### 4.6 Bridge secret + peer URL

```sh
openssl rand -base64 48   # ≥32 ký tự → BRIDGE_SECRET / SABLE_BRIDGE_SECRET
```

1. Vault: `BRIDGE_PEER_URL` (https), `BRIDGE_SECRET`, tuỳ `BRIDGE_PEER_TOKEN`
   — hoặc env `SABLE_BRIDGE_URL` / `SABLE_BRIDGE_SECRET` / `SABLE_BRIDGE_PEER_TOKEN`.
2. Peer (Grok Bot webhook) **bạn tự tạo/duyệt** — Sable không tạo hộ.
3. Đừng để `SABLE_BRIDGE=0` nếu muốn bật; chưa cấu hình → inbound `403 bridge_off`.

### 4.7 Embeddings (recall semantic)

- `OPENAI_API_KEY` và/hoặc `SABLE_EMBED_PROVIDER=openai` + `SABLE_EMBED_MODEL`, hoặc
- local / `hash` (mặc định auto → hash nếu thiếu khóa). Paraphrase yếu với hash
  (R@5 0.42 — xem 01).

### 4.8 Voice

`VOICE_API_KEY` (hoặc `OPENAI_API_KEY`), tuỳ `VOICE_BASE_URL`, model/voice mặc định
`whisper-1` / `tts-1` / `alloy`.

## 5. Vault vs env

| Loại | Đặt ở đâu |
|---|---|
| Master `SABLE_VAULT_KEY` | **Chỉ env** (`.env.local` / secret manager) |
| `BRIDGE_PEER_URL`, `BRIDGE_SECRET`, `BRIDGE_PEER_TOKEN` | **Vault ưu tiên**; env `SABLE_BRIDGE_*` fallback |
| `GOOGLE_OAUTH_CLIENT_ID` / `SECRET` | **Vault ưu tiên**; env `SABLE_GOOGLE_CLIENT_*` fallback |
| `SABLE_IMAGE_API_KEY` | Env hoặc vault cùng tên |
| `OAUTH_TOKEN_GMAIL` / `GCAL` / pending | **Chỉ vault** — app ghi sau Connect; `/api/vault` không trả giá trị |
| LLM keys, Telegram token, SMTP pass, webhook secret, `SABLE_PASSWORD` | Env (hoặc secret manager host) |

## 6. Bật / tắt tính năng (kill switch)

Hầu hết: **unset = bật**; `SABLE_<NAME>=0` = tắt. Ngoại lệ đáng nhớ:

- `SABLE_SCOPE=0` → **deny** mọi ACT cần scope (fail-closed).
- `SABLE_BRIDGE=0` → tắt; hoặc chưa có URL+secret → off (`bridge_off`).
- `SABLE_CHAT_QUEUE=0` → desk/API turns kiểu pre-W7.
- Brief/nightly: kill `SABLE_BRIEF` / self-eval; routine builtin còn **default off** trong settings.

Khởi động thận trọng (checklist VPS): `SABLE_BRIDGE=0`, cân nhắc `SABLE_DESKTOP=0`,
brief/nightly off; bật từng lớp và chạy `npm run eval:wN`.

Danh sách đầy đủ: nhóm «Kill switches» trong `.env.example` và
[06-bao-mat-van-hanh.md](./06-bao-mat-van-hanh.md).

## 7. Bảng tham chiếu nhanh theo nhóm

Xem **từng dòng** trong `.env.example` (mô tả + mặc định + bắt buộc?). Đếm nhóm:

| Nhóm | Nội dung chính |
|---|---|
| Provider LLM | XAI/OPENAI/DEEPSEEK/LLM/OLLAMA/LOCAL + keys |
| Model router | `SABLE_MODEL_*`, `SABLE_MAX_STEPS` |
| Auth / harden | password, trusted origins, CSRF/rate, Better Auth, `DATABASE_URL` |
| Paths / process | data/workspace, headless, chrome, novnc, MCP, fetch allow |
| Vault | `SABLE_VAULT*` + tên vault |
| Kill switches | `SABLE_JOBS` … `SABLE_CHAT_QUEUE` |
| Jobs / spawn / budget | concurrency, TTL, heavy, budget caps |
| Memory | max, journal, model |
| Telegram / SMTP / webhook | token, owners, HMAC |
| OAuth / bridge | Google + bridge |
| Chat W7 | queue, concurrency |
| Desktop / research / code | ports, USD caps, models |
| Media / voice | image/video/voice |
| Vector / trace | embed, recall, retain |
| Test-only | smoke/preview fixtures |

Cập nhật file example rồi chạy:

```sh
node --test scripts/check-env-example.mjs
# hoặc: npm test
```

## 8. Checklist sau khi boot

- [ ] `curl -s http://127.0.0.1:$SABLE_PORT/api/health` → 200
- [ ] Chat một câu trên desk (model trả lời)
- [ ] Public (nếu có): không auth → 401; `-u sable:$SABLE_PASSWORD` → 200
- [ ] `GET /api/channels` — Telegram/webhook đúng trạng thái, **không** lộ token
- [ ] `GET /api/vault` — `configured: true` nếu đã set vault key; chỉ **tên**
- [ ] OAuth (nếu dùng): Connect Gmail/Calendar → "Đã kết nối"
- [ ] Bridge (nếu dùng): Settings → Test ping (mock) OK; peer chỉ sau khi duyệt
- [ ] Kill thử: `SABLE_SHELL=0` + restart → shell tool/chip off
- [ ] Backup: tar `$SABLE_DATA_DIR` + giữ `.env.local` offline mã hóa
- [ ] `npx tsc --noEmit` và `npm test` xanh trên host mới (khuyến nghị)

## 9. Liên kết

- Cài VPS tổng: [04-cai-dat-vps.md](./04-cai-dat-vps.md)
- OAuth EN: `docs/OAUTH-SETUP.md`
- Webhook EN: `docs/WEBHOOK-API.md`
- Bridge EN: `docs/BRIDGE-PROTOCOL.md`
- Deploy: `docs/DEPLOY.md`
