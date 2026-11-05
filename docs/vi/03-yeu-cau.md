# 03 · Yêu cầu hệ thống

Nguồn: `docs/FULL-AGENTIC-STATUS.md` (checklist VPS), `docs/DEPLOY.md`,
`docs/PHASE3-SETUP.md`, `package.json` (`@types/node` ^22), Phase 5/W3 notes,
binary trên box tham chiếu (`bwrap`, `Xvfb`, `x11vnc`, `websockify`,
`google-chrome`).

> `package.json` **không** khai báo trường `engines`; checklist chính thức ghi
> **Node 22+**. Box phát triển từng chạy Node 24.x thành công với bộ test hiện tại.

## Hệ điều hành

- **Khuyến nghị:** Ubuntu Server (hoặc Debian tương đương) x86_64, user riêng không
  phải root để chạy process Sable.
- Cần kernel hỗ trợ **bubblewrap** (user namespaces) nếu muốn shell/code/desktop
  jail đầy đủ; thiếu `bwrap` thì shell có đường cwd-jail dự phòng (yếu hơn — xem
  Phase 5).

## Node.js & npm

| Mục | Giá trị |
|---|---|
| Node | **22+** (checklist); cài qua NodeSource / nvm / distro |
| npm | Đi kèm Node; cài deps bằng `npm ci` |
| TypeScript | Trong dependencies (`typescript` ^5.7); kiểm tra `npx tsc --noEmit` |

## RAM & CPU

| Tình huống | Định mức đã quan sát / ghi chú |
|---|---|
| Vite dev baseline (sau W7) | ~**866 MB** RSS process vite |
| W2c ghi nhận | ~1.75 GB RSS tại một lần đo (trước tối ưu/wave sau) |
| Desktop `:99` đang chạy | ~**+1.2 GB** cộng dồn (Xvfb, Chrome, x11vnc, websockify, WM…) |
| Khuyến nghị host | Checklist: ~**1 GB** nền + thêm ~**1.2 GB** khi bật desktop; máy **≥ 4 GB** thoải mái, **≥ 8 GB** nếu bật desktop + embed local |

CPU: 1–2 vCPU đủ chat/job; research/desktop song song (heavy ≤2) nên ≥2 vCPU.

## Ổ đĩa

- Repo + `node_modules` sau `npm ci`: vài trăm MB–vài GB tùy cache.
- `$SABLE_DATA_DIR` (jobs, desk, memory, vault, vector, research, code meta): bắt
  đầu nhỏ; vector ≤ `SABLE_VECTOR_MAX_CHUNKS` (mặc định 20000) — ví dụ 5000 chunk
  ~5.3 MB trên đĩa (W5).
- Workspace agent (`SABLE_WORKSPACE` / task worktrees / media): tùy dùng.
- Log `.grok/headless.log`, `/tmp/sable-*.log`: xoay vòng thủ công.

Khuyến nghị: ổ bền cho `SABLE_DATA_DIR` mode **0700**, backup mã hóa.

## Gói hệ thống

### Bắt buộc cho core (UI + chat + jobs)

```sh
# ví dụ Ubuntu
sudo apt update
sudo apt install -y git curl ca-certificates build-essential
# Node 22+ (ví dụ)
# curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
# sudo apt install -y nodejs
```

### Mạnh khuyến nghị (shell jail)

```sh
sudo apt install -y bubblewrap
```

### Desktop agent (W3) — tùy chọn nhưng cần đủ bộ nếu bật `SABLE_DESKTOP`

```sh
sudo apt install -y xvfb x11vnc websockify xdotool
# Chrome/Chromium — trên box dùng /usr/bin/google-chrome
# WM tùy chọn: xfwm4 (SABLE_DESKTOP_WM)
# noVNC files: thường /usr/share/novnc (SABLE_NOVNC_DIR)
```

Playwright/Chromium cho **browser tool** (Phase 5): cài theo tài liệu Playwright
sau `npm ci` nếu chưa có browser.

### Khác

- `openssl` — tạo khóa vault / HMAC ví dụ trong docs.
- Reverse proxy: `caddy` hoặc `nginx` (TLS).
- (Tuỳ chọn tunnel) `ngrok` — không bắt buộc trên VPS có domain.

## Biến môi trường / khóa

### Bắt buộc để chat thật

Ít nhất **một** khóa LLM (theo `startup.sh`):

- `XAI_API_KEY` **hoặc**
- `OPENAI_API_KEY` **hoặc**
- `DEEPSEEK_API_KEY` **hoặc**
- `LLM_API_KEY` (+ `LLM_BASE_URL` / `LLM_MODELS` / `LLM_API_STYLE` nếu cần)

### Bắt buộc khi expose công khai

- `SABLE_PASSWORD` — HTTP basic (user `sable`) trên tunnel/proxy nếu bạn bật
  lớp đó; **không** commit, **không** dán vào chat.
- `SABLE_TRUSTED_ORIGINS` — origin https công khai (CSRF / OAuth base).

### Nên có sớm

| Biến | Việc mở khóa |
|---|---|
| `SABLE_DATA_DIR` | Thư mục dữ liệu bền (0700) |
| `SABLE_VAULT_KEY` | Vault AES-GCM → OAuth tokens, bridge secret… (**cần cấu hình**) |
| `SABLE_WEBHOOK_SECRET` | ≥16 ký tự nếu dùng webhook |

### Tùy chọn (đánh dấu cần cấu hình trên status hiện tại)

| Biến | Việc mở khóa |
|---|---|
| `SABLE_TELEGRAM_TOKEN`, `SABLE_TELEGRAM_OWNER_IDS` | Telegram |
| `SABLE_GOOGLE_CLIENT_ID` / `SECRET` hoặc vault `GOOGLE_OAUTH_*` | Gmail + Calendar |
| `SABLE_OAUTH_REDIRECT_BASE` | Redirect OAuth nếu khác trusted origin đầu |
| `OPENAI_API_KEY` / `SABLE_EMBED_PROVIDER` / `SABLE_EMBED_MODEL` | Embeddings semantic |
| `SABLE_MODEL_LIGHT` | Triage/self-eval grader model |
| `SABLE_BRIDGE_URL`, `SABLE_BRIDGE_SECRET` (≥32) hoặc vault `BRIDGE_*` | Bridge peer |
| `SABLE_SMTP_*` | Email notify |
| `VOICE_*` / `OPENAI_*` audio | Voice STT/TTS |
| `MCP_SERVERS` | MCP qua env (allowLocal chỉ ở đây) |
| `SABLE_IMAGE_*` / video models | Media gen ngoài xAI mặc định |

Chi tiết nghĩa từng biến: [04-cai-dat-vps.md](./04-cai-dat-vps.md) và các file
`docs/*.md` tiếng Anh.

## Mạng

- Outbound HTTPS tới provider LLM, Telegram API, (tuỳ chọn) Google, peer bridge.
- Inbound: `:8080` local; public qua reverse proxy TLS hoặc ngrok.
- Desktop egress đi qua proxy SSRF của Sable — không mở Chrome thẳng ra mạng host
  ngoài policy đó.
