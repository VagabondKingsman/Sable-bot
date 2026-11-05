# 06 · Bảo mật & vận hành

Nguồn: `docs/FULL-AGENTIC-STATUS.md`, `docs/DEPLOY.md`, `docs/PHASE6-PROGRESS.md`
(W2c harden, W3–W7), `src/server/harden.ts`, `scripts/headless.mjs`,
`scripts/eval-w*.mjs`, `package.json` scripts.

## Mô hình bảo mật

1. **Một operator.** Process duy nhất trên một `SABLE_DATA_DIR`.
2. **Mọi gửi/ghi nhạy cảm = thẻ duyệt owner.** Background
   (routine/trigger/agent/subagent) không `canDecide` tool owner-only (desktop
   action, code.apply, bridge, gmail_send, …). Channel Telegram/webhook không
   duyệt chuỗi owner-only đó.
3. **Untrusted boundaries.** Tool output, MCP, webhook body, bridge inbound,
   recall block — đánh dấu dữ liệu, không phải instruction.
4. **Isolation.** Workspace ≠ data dir ≠ home; bwrap `--unshare-all` (shell/code/
   desktop); SSRF `checkUrl` + chặn private/metadata; redirect kiểm lại từng hop.
5. **Secrets.** Không log/API trả giá trị; vault names-only; redaction pattern
   (`ya29.`, `GOCSPX-`, `xai-`, …). Env Sable không truyền vào sandbox/desktop/
   eval children.
6. **Fail-closed kill switches** cho các cổng nguy hiểm (Scope, Bridge off, …).

### Harden HTTP (Vite middleware)

Áp trên `/api/*` và `/s/*` khi chạy `vite dev` (gap: chưa gắn Nitro production):

| Cơ chế | Hành vi |
|---|---|
| Rate | Đọc ~600/phút/IP; ghi ~120; share `/s/` ~60; loopback không XFF exempt |
| Body | Content-Length > ~10 MB → 413 (`SABLE_MAX_BODY`) |
| CSRF | POST/PUT/PATCH/DELETE cần Origin trong trusted / localhost / cùng Host; `null` từ chối |
| Exempt HMAC | `/api/channels/webhook`, `/api/routines/<id>/fire` (+ bridge inbound tự auth) |

Kill: `SABLE_RATE=0`, `SABLE_CSRF=0`.

### Approvals & audit

- TTL job approval: `SABLE_JOB_APPROVAL_TTL_*` (Telegram: mặc định 24 h theo
  PHASE3 — hết hạn = từ chối).
- `GET /api/audit` — initiator_kind trên side effect.
- Chip trả lời **không bao giờ gửi** (W2a).

## Kill switches (danh sách vận hành)

Đặt `=0` rồi restart process (một số route hot-reload; an toàn nhất là restart
headless/systemd).

**Nền tảng:** `SABLE_JOBS`, `SABLE_CHANNELS`, `SABLE_TOOLS`, `SABLE_MEMORY`,
`SABLE_SHELL`, `SABLE_BROWSER`, `SABLE_VOICE`, `SABLE_PROFILES`, `SABLE_SPAWN`,
`SABLE_SKILLS`, `SABLE_MCP`, `SABLE_TRIGGERS` / routines, `SABLE_WEBHOOK`,
`SABLE_DESK_SYNC`, `SABLE_OLLAMA`.

**Full Agentic:** `SABLE_CATCHUP`, `SABLE_VAULT`, `SABLE_ROUTER`, `SABLE_SCOPE`
(off = deny ACT), `SABLE_TOOLINDEX`, `SABLE_PLANNER`, `SABLE_WORKSPACES`,
`SABLE_BUDGET`, `SABLE_MODEL_ROUTER`, `SABLE_TRACE`, `SABLE_MEDIA`,
`SABLE_MEDIA_TOOL`, `SABLE_CANVAS`, `SABLE_SHARE`, `SABLE_TRIAGE`, `SABLE_BRIEF`,
`SABLE_PROACTIVE`, `SABLE_OAUTH`, `SABLE_CSRF`, `SABLE_RATE`, `SABLE_DESKTOP`,
`SABLE_RESEARCH`, `SABLE_CODEAGENT`, `SABLE_VECTOR`, `SABLE_RECALL_CONTEXT`,
`SABLE_SELFEVAL`, `SABLE_BRIDGE`, `SABLE_CHAT_QUEUE`.

Khởi động thận trọng (checklist VPS): Bridge off, Desktop off, brief/nightly off.

## Xử lý bí mật

| Việc | Cách đúng |
|---|---|
| Lưu | `.env.local` 0600 hoặc secret manager host; vault sau khi có `SABLE_VAULT_KEY` |
| Git | `.gitignore` đã loại `.env*`; **không** force-add |
| Chat / ticket | Không dán `SABLE_PASSWORD`, `XAI_API_KEY`, ngrok authtoken, vault key |
| Backup | Tar data + env offline, mã hóa |
| Quay vòng | Đổi password/ngrok/OAuth; revoke Google Connect; đổi `BRIDGE_SECRET` cả hai đầu |
| Scan artifact | Key-pattern scan trước khi phát hành tarball (như các wave W*) |

## Vận hành hàng ngày

### Process & log

```sh
npm run headless:status
# hoặc: systemctl status sable
tail -n 100 /opt/sable/.grok/headless.log
# box mẫu: /tmp/sable-startup.log , /tmp/sable-watchdog.log
```

Watchdog headless: restart con khi crash (backoff ≤60 s), ping
`SABLE_HEADLESS_PING` (mặc định `/api/jobs`).

Trên box phát triển: `/home/box/bin/sable-watchdog.sh` gọi `startup.sh`, tick
health, giữ ngrok trả 401/200 — **đường dẫn box-specific**, VPS dùng systemd.

### Heartbeat suspend

`POST /api/health` ghi `heartbeat.json`. Gap ≥ 90 s → `wokeFromSuspend`; routine
catch-up tối đa một lần/routine trừ khi `SABLE_CATCHUP=0`.

### Kiểm thử & eval

```sh
npx tsc --noEmit
npm test
npm run eval          # mock agent cases
npm run eval:w0
# …
npm run eval:w7
# live model steer W7 (tốn token):
# SABLE_EVAL_LIVE_MODEL=1 npm run eval:w7
```

Nightly builtin `builtin:nightly-eval` **mặc định tắt**; chạy suite với env tối
thiểu (không kế thừa secret Sable).

### Giám sát nhanh

| Check | Kỳ vọng |
|---|---|
| `GET /api/health` | 200 |
| Public không credential | 401 (nếu basic phía trước) |
| Public có basic | 200 |
| `GET /api/channels` | trạng thái TG/webhook không lộ token |
| `GET /api/vault` | chỉ tên; configured theo key |
| `GET /api/bridge` | không có giá trị secret trong JSON |

### Nâng cấp an toàn

1. Backup data + `.env.local`.
2. `git pull` + `npm ci` + tsc + test + eval wave liên quan.
3. Đọc gap/breaking trong PHASE6.
4. Bật dần kill switch mới.
5. Key-pattern scan artifact nếu đóng gói.

### Sự cố bảo mật

- Nghi ngờ lộ key → rotate ngay; `SABLE_BRIDGE=0` / `SABLE_CHANNELS=0` / đổi
  webhook secret; revoke OAuth.
- Abuse rate → hạ `SABLE_RATE_*` hoặc tắt public tạm.
- Share link lộ → Thu hồi / `SABLE_SHARE=0`.
