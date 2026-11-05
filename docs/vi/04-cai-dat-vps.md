# 04 · Cài đặt từ đầu trên VPS (Ubuntu)

Hướng dẫn bám `docs/DEPLOY.md`, `docs/FULL-AGENTIC-STATUS.md`,
`docs/PHASE3-SETUP.md`, `docs/OAUTH-SETUP.md`, `docs/WEBHOOK-API.md`,
`docs/BRIDGE-PROTOCOL.md`, `docs/CANVAS-SHARE.md`, `startup.sh`,
`scripts/headless.mjs`. Lệnh clone dùng remote công khai:

`https://github.com/VagabondKingsman/Sable-bot`

**Không** đưa giá trị secret thật vào file này — dùng placeholder
`<...>` / `đổi-me`.

## 0. Chuẩn bị VPS

1. Tạo user (ví dụ `sable`), thêm vào `sudo`.
2. Firewall: mở 22 (SSH), 80/443 (proxy). **Không** mở 8080 ra Internet nếu đã có
   reverse proxy trên cùng máy.
3. Cài Node 22+, git, curl, build-essential, bubblewrap; (tuỳ chọn desktop) Xvfb,
   x11vnc, websockify, Chrome/Chromium, xdotool — xem [03-yeu-cau.md](./03-yeu-cau.md).

## 1. Clone và cài dependency

```sh
sudo mkdir -p /opt/sable /var/lib/sable
sudo chown sable:sable /opt/sable /var/lib/sable
sudo -u sable -i
cd /opt
git clone https://github.com/VagabondKingsman/Sable-bot.git sable
cd /opt/sable
npm ci
npx tsc --noEmit
npm test          # lâu; kỳ vọng scripts 197 + src 413 (sau W7)
# tùy chọn: npm run eval:w0 … eval:w7
```

Nếu clone private: dùng SSH deploy key hoặc credential helper — **không** nhúng
token vào URL remote lâu dài.

## 2. Thư mục dữ liệu & workspace

```sh
export SABLE_DATA_DIR=/var/lib/sable
chmod 700 /var/lib/sable
# Workspace agent (fs/shell/browser) — tách khỏi data + .env
mkdir -p /var/lib/sable-workspace
export SABLE_WORKSPACE=/var/lib/sable-workspace
# Task workspaces (W1), mặc định code dùng /workspace/... trên box; trên VPS đặt:
# export SABLE_TASK_WORKSPACE_ROOT=/var/lib/sable-workspace/tasks
```

**Không** đặt API key trong thư mục workspace (agent có thể `fs_read`).

## 3. File môi trường `.env.local`

**Hướng dẫn đầy đủ + bảng mọi biến:** [08-cau-hinh-env.md](./08-cau-hinh-env.md) và gốc repo [`.env.example`](../../.env.example).

Tạo `/opt/sable/.env.local` (mode **0600**, trong `.gitignore`). `startup.sh` và
headless load file này; **không commit**.

### 3.1 Khung tối thiểu

```sh
# --- bắt buộc cho chat ---
XAI_API_KEY=<your-xai-key>
# hoặc OPENAI_API_KEY=... / DEEPSEEK_API_KEY=... / LLM_API_KEY=...

# --- public ---
SABLE_PASSWORD=<your-basic-auth-password>
SABLE_TRUSTED_ORIGINS=https://sable.example.com
SABLE_PORT=8080
SABLE_PUBLIC=1
SABLE_DATA_DIR=/var/lib/sable
SABLE_WORKSPACE=/var/lib/sable-workspace

# --- vault (cần cấu hình để OAuth/bridge trong vault) ---
SABLE_VAULT_KEY=   # openssl rand -base64 32

# --- webhook (nếu dùng) ---
# SABLE_WEBHOOK_SECRET=ít-nhất-16-ký-tự
# SABLE_WEBHOOK_URL=https://client.example.com/hook
# SABLE_WEBHOOK_OWNER=owner
```

Tạo vault key:

```sh
umask 077
openssl rand -base64 32 >> /opt/sable/.env.local   # gắn vào SABLE_VAULT_KEY=
chmod 600 /opt/sable/.env.local
```

### 3.2 Biến thường dùng

Danh sách **đầy đủ có mặc định** nằm trong `.env.example` (mỗi dòng một chú thích tiếng Việt).
Tóm tắt nhóm — chi tiết xem [08](./08-cau-hinh-env.md):

Nhóm **LLM / model**

| Biến | Nghĩa |
|---|---|
| `XAI_API_KEY`, `XAI_BASE_URL`, `XAI_MODELS`, `XAI_API_STYLE` | xAI |
| `OPENAI_*`, `DEEPSEEK_*`, `LLM_*` | Provider khác / generic |
| `OLLAMA_BASE_URL`, `OLLAMA_MODELS`, `SABLE_OLLAMA` | Ollama |
| `LOCAL_BASE_URL`, `LOCAL_MODELS`, `LOCAL_API_KEY` | LM Studio / vLLM… |
| `SABLE_MODEL_DEFAULT`, `SABLE_MODEL_HARD`, `SABLE_MODEL_LIGHT`, `SABLE_MODEL_CHEAP` | Chọn / router |
| `SABLE_MODEL_ROUTER=0` | Luôn hard |
| `SABLE_MAX_STEPS`, `SABLE_RESPONSES_STATELESS` | Giới hạn vòng / style |

Nhóm **auth / mạng app**

| Biến | Nghĩa |
|---|---|
| `SABLE_PASSWORD` | Basic auth user `sable` (khi bạn bật lớp đó trên proxy/ngrok) |
| `SABLE_TRUSTED_ORIGINS` | Origin https được CSRF/OAuth tin |
| `SABLE_CSRF=0`, `SABLE_RATE=0` | Tắt harden (không khuyến nghị public) |
| `SABLE_RATE_READ`, `SABLE_RATE_WRITE`, `SABLE_RATE_SHARE` | Override hạn mức |
| `SABLE_MAX_BODY` | Cap Content-Length |
| `SABLE_PUBLIC=1` | Tắt HMR websocket (tunnel-friendly) |
| `SABLE_HMR` | Điều khiển HMR |

Nhóm **data / core kill**

| Biến | Nghĩa |
|---|---|
| `SABLE_DATA_DIR` | Jobs, memory, desk, vault, … |
| `SABLE_WORKSPACE` | Jail fs/shell/browser |
| `SABLE_JOBS=0`, `SABLE_CHANNELS=0`, `SABLE_TOOLS=0` | Tắt lớp |
| `SABLE_MEMORY=0`, `SABLE_MEMORY_MAX`, `SABLE_MEMORY_MODEL`, `SABLE_MEMORY_JOURNAL_DAYS` | Memory |
| `SABLE_DESK_SYNC=0` | Tắt đồng bộ desk server |

Nhóm **Telegram / SMTP / webhook** — xem PHASE3 + WEBHOOK-API; thêm W7
`SABLE_CHANNEL_ACK_MS` (mặc định 5000).

Nhóm **Full Agentic (W0–W7)** — mỗi module một kill `SABLE_<NAME>=0`:
`CATCHUP`/`ROUTINE_CATCHUP`, `VAULT`, `ROUTER`, `SCOPE`, `TOOLINDEX`, `PLANNER`,
`WORKSPACES`, `BUDGET`, `TRACE`, `MEDIA`, `MEDIA_TOOL`, `CANVAS`, `SHARE`,
`TRIAGE`, `BRIEF`, `PROACTIVE`, `OAUTH`, `DESKTOP`, `RESEARCH`, `CODEAGENT`,
`VECTOR`, `SELFEVAL`, `BRIDGE`, `CHAT_QUEUE`, cộng `SHELL`, `BROWSER`, `VOICE`,
`PROFILES`, `SPAWN`, `SKILLS`, `MCP`, `TRIGGERS`, …

Nhóm **cap / ngân sách**

| Biến | Mặc định khái niệm (xem code nếu cần số exact) |
|---|---|
| `SABLE_BUDGET_MAX_TOKENS`, `SABLE_BUDGET_MAX_USD` | Trần global |
| `SABLE_DESKTOP_RUN_USD`, `SABLE_RESEARCH_RUN_USD`, `SABLE_CODE_RUN_USD` | Trần mỗi run (research/code/desktop thường 0.5) |
| `SABLE_CHAT_CONCURRENCY` | Mặc định 3 |
| `SABLE_HEAVY_MAX` | Heavy song song (D7, thường 2) |

Nhóm **OAuth / bridge / embed** — **cần cấu hình** trên status hiện tại: xem
OAUTH-SETUP + BRIDGE-PROTOCOL; `SABLE_EMBED_PROVIDER`, `SABLE_EMBED_MODEL`,
`OPENAI_API_KEY`.

## 4. Chạy lần đầu

```sh
cd /opt/sable
set -a; . ./.env.local; set +a
npm run headless:start
npm run headless:status
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
# kỳ vọng 200 local (không basic trên loopback theo thiết kế box)
```

Dừng: `npm run headless:stop`. Log: `.grok/headless.log`.

Hoặc foreground dưới systemd: `node scripts/headless.mjs run` (xem mục 5).

`startup.sh` trong repo dành cho box có đường dẫn `/workspace/sable` — trên VPS
nên dùng headless/systemd với `WorkingDirectory=/opt/sable`.

## 5. systemd

Theo `docs/DEPLOY.md` (chỉnh đường dẫn/user cho khớp):

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
Environment=SABLE_DATA_DIR=/var/lib/sable

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now sable
sudo systemctl status sable
```

## 6. HTTPS / reverse proxy

### 6.1 Domain Cloudflare + Caddy/nginx (khuyến nghị VPS)

- DNS A/AAAA → VPS; proxy Cloudflare tùy chọn.
- TLS terminate tại Caddy/nginx → `http://127.0.0.1:8080`.
- Đặt `SABLE_TRUSTED_ORIGINS=https://sable.example.com`.
- Giữ auth desk trên hầu hết path. Endpoint máy đã tự xác thực HMAC có thể
  exempt basic-auth ở proxy nếu muốn peer gọi trực tiếp:
  - `/api/channels/webhook`
  - `/api/routines/<id>/fire`
  - `/api/bridge/inbound`
  (chúng vẫn CSRF-exempt trong harden Vite và tự kiểm HMAC/secret.)

Ví dụ Caddy rút gọn:

```caddy
sable.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Thêm `basicauth` ở Caddy **hoặc** dựa vào `SABLE_PASSWORD` / Better Auth tùy
cách bạn triển khai — trên box hiện tại ngrok policy gắn basic phía trước mọi
path.

### 6.2 ngrok (dev / tạm)

```sh
# sau khi cài ngrok + authtoken (cần cấu hình — không lưu token vào git)
export SABLE_TRUSTED_ORIGINS=https://<subdomain>.ngrok-free.dev
# tunnel tới 127.0.0.1:8080; kỳ vọng 401 không auth / 200 với -u sable:$SABLE_PASSWORD
```

Watchdog mẫu trên box (`/home/box/bin/sable-watchdog.sh`) tick `POST /api/health`
và restart ngrok khi hỏng — trên VPS production thường **không** cần ngrok nếu
đã có domain.

## 7. Telegram

1. `@BotFather` → `/newbot` → token.
2. Lấy numeric user id (ví dụ `@userinfobot`).
3. Trong `.env.local`:

```sh
SABLE_TELEGRAM_TOKEN=<token>
SABLE_TELEGRAM_OWNER_IDS=<id-của-bạn>
# tuỳ chọn: SABLE_TELEGRAM_TOOLS=files,fetch
# SABLE_TELEGRAM_NOTIFY=own|all|off
# SABLE_TELEGRAM_RATE=20
```

4. Restart Sable; `GET /api/channels` → `telegram.running: true`.
5. Chat **riêng** với bot: `/help`, `/new`, `/status`. Group/stranger bị bỏ
   silent. W7: tin lúc bot bận được steer; "Đã nhận ✓" chỉ sau ~5 s nếu vẫn chạy.

## 8. Google OAuth (Gmail + Calendar)

Làm đúng `docs/OAUTH-SETUP.md`. Tóm tắt:

1. Có `SABLE_VAULT_KEY` (**cần cấu hình**).
2. Google Cloud: bật Gmail API + Calendar API; consent Testing; 4 scope readonly/
   compose / calendar; thêm test user.
3. OAuth client Web → redirect chính xác:

   `https://<public-origin>/api/oauth/callback`

4. Đưa client id/secret vào vault (`GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`) hoặc env `SABLE_GOOGLE_CLIENT_*`.
5. UI **Cách Sable làm việc → Kết nối → Connect**. Testing: refresh hết sau **7 ngày**.

## 9. Webhook

```sh
SABLE_WEBHOOK_SECRET=<≥16 ký tự>
# SABLE_WEBHOOK_URL=https://...   # outbound SSRF-checked
# SABLE_WEBHOOK=0 để tắt
```

Ví dụ ping: xem `docs/WEBHOOK-API.md` (openssl HMAC + curl; qua ngrok vẫn cần
basic nếu policy yêu cầu). Replay cùng `id` → 409 ~10 phút.

## 10. Bridge (tuỳ chọn)

1. Vault key + `BRIDGE_SECRET` (≥32) + `BRIDGE_PEER_URL` (https) trong vault
   (hoặc env `SABLE_BRIDGE_*`).
2. Phía peer (Grok Bot webhook) **chủ sở hữu tự tạo/duyệt** — Sable không tạo hộ.
3. Settings → Bridge → Test ping (mock) → Ping peer (thẻ duyệt).
4. `SABLE_BRIDGE=0` tắt ngay.

## 11. Backup

```sh
# dừng hoặc đảm bảo consistency tùy mức chấp nhận
sudo tar -czf ~/sable-data-$(date +%Y%m%d).tgz -C / var/lib/sable
# Sao .env.local offline (mã hóa). Không đưa vào git / chat.
```

Khôi phục: giải nén vào `SABLE_DATA_DIR`, giữ mode 0700/0600, restart service.

## 12. Cập nhật

```sh
cd /opt/sable
sudo systemctl stop sable   # hoặc npm run headless:stop
git pull --ff-only
npm ci
npx tsc --noEmit
npm test                    # khuyến nghị
# npm run eval:w7           # hoặc bộ eval bạn quan tâm
sudo systemctl start sable
curl -s http://127.0.0.1:8080/api/health
```

Đọc `docs/PHASE6-PROGRESS.md` / changelog commit trước khi bật kill switch mới.

## 13. Kiểm tra sức khỏe

```sh
curl -s http://127.0.0.1:8080/api/health
curl -s http://127.0.0.1:8080/api/jobs | head
curl -s http://127.0.0.1:8080/api/channels | head
npm run headless:status
# public:
curl -s -o /dev/null -w '%{http_code}\n' https://sable.example.com/
# với basic: curl -u sable:"$SABLE_PASSWORD" ...
```

## 14. Sự cố thường gặp

| Triệu chứng | Hướng xử lý |
|---|---|
| Chat/media 503 | Thiếu LLM key trong env process |
| CSRF 403 POST | Thêm origin vào `SABLE_TRUSTED_ORIGINS`; không gửi Origin lạ |
| Telegram không chạy | Token/owner; `SABLE_CHANNELS`; mở UI/`/api/jobs` một lần để boot |
| Vault / OAuth not-configured | Thiếu `SABLE_VAULT_KEY` hoặc client Google |
| Bridge 403 `bridge_off` | Chưa URL+secret hoặc `SABLE_BRIDGE=0` |
| Desktop không start | Thiếu Xvfb/Chrome/`bwrap`; xem log; `SABLE_DESKTOP` |
| Shell không jail | Cài `bubblewrap`; kiểm tra user namespaces |
| Hai process một data dir | **Không** — chỉ một owner `$SABLE_DATA_DIR` |
| ngrok 401 mãi | Bình thường khi chưa `-u sable:…` |
| OOM khi desktop | Tắt desktop / nâng RAM; idle stop 10 phút |

Kill switch an toàn khi mới lên production (checklist): bắt đầu
`SABLE_BRIDGE=0`, `SABLE_DESKTOP=0`, brief/nightly off; bật từng cái và chạy
`eval:wN` tương ứng.
