# 01 · Giới thiệu Sable

Nguồn: `docs/FULL-AGENTIC-STATUS.md`, `docs/PHASE6-PROGRESS.md`, `docs/DEPLOY.md`,
`package.json`, các `scripts/eval-w*.mjs`.

## Sable là gì

Sable là **desk agent một người vận hành**. Một process sở hữu `$SABLE_DATA_DIR`
(mặc định `/workspace/sable-data` trên box phát triển; trên VPS nên trỏ ổ bền)
và cung cấp:

- UI chat / nền tảng công cụ trên `:8080`
- Lịch job, routine, trigger (webhook fire + watch URL/RSS)
- Kênh Telegram (long-poll) và webhook HMAC
- SMTP chỉ để **thông báo** tới đúng một địa chỉ cấu hình sẵn
- Các agent nặng: desktop computer-use (`:99`), research có trích dẫn, code
  worktree (không push/PR theo mặc định D6)

Mọi hành động **gửi ra ngoài / ghi hệ thống** cần thẻ duyệt của owner. Initiator
nền (routine, trigger, agent, subagent) **không bao giờ tự duyệt** và không tự gửi.

## Triết lý vận hành

1. **Owner-only.** Telegram chỉ nhận chat riêng của id trong
   `SABLE_TELEGRAM_OWNER_IDS`; webhook chỉ `peerId` = `SABLE_WEBHOOK_OWNER`;
   thẻ duyệt desktop / code apply / bridge chỉ owner web.
2. **Fail-closed khi tắt cổng.** Ví dụ `SABLE_SCOPE=0` từ chối mọi ACT cần scope;
   `SABLE_BRIDGE=0` hoặc chưa cấu hình → inbound `403 bridge_off`.
3. **Sandbox thật.** Shell/code/desktop chạy trong bubblewrap (`bwrap`); fetch/
   outbound qua SSRF guard; workspace jail tách khỏi `$SABLE_DATA_DIR` và `.env`.
4. **Kill switch theo lớp.** Tắt từng module bằng biến `SABLE_*=0` mà không cần
   rebuild (xem [06-bao-mat-van-hanh.md](./06-bao-mat-van-hanh.md)).
5. **Đo và eval.** Mỗi wave W0–W7 có `npm run eval:wN`; bộ eval agent mock
   `npm run eval` (22 case Phase 4, mở rộng Phase 5).

## Ưu điểm (có số đo trong repo)

Các con số dưới đây là **kết quả chạy eval/live đã ghi trong**
`docs/PHASE6-PROGRESS.md` / Phase 4–5. Chúng phản ánh bộ test của dự án, không
phải benchmark công nghiệp độc lập.

| Hạng mục | Kết quả đã ghi | Nguồn |
|---|---|---|
| Eval agent mock + mở rộng Phase 5 | **29/29** case (gồm shell/browser/webhook/profile) | PHASE5-PROGRESS |
| Live capability harness (grok-4.7) | **29/29** curated checks | PHASE5-PROGRESS (5b) |
| Research citation (live web) | **26/26** cite khớp nguyên văn excerpt đã fetch | PHASE6 W4 |
| Triage held-out 60 mục | Rules+heuristic **65.0%**; với light model (grok-4.5 tier) **93.3%** | PHASE6 W2c |
| Triage eval:w2a (bộ tự soạn, 40 mục) | Gate 100% — *lạc quan*, không thay held-out | PHASE6 W2a |
| Hybrid recall (hash embedder) keyword/fuzzy | R@5 ≈ **1.00** trên bộ 36 truy vấn tự soạn | PHASE6 W5 |
| Hybrid recall paraphrase | R@5 **0.42** (hash lexical) | PHASE6 W5 — cần embeddings thật |
| Unit test sau W7 | scripts **197** + src **413**, 0 fail | PHASE6 W7 |
| Eval waves | `eval:w0`…`eval:w7` xanh (w7: 8 pass + 1 skip trừ khi `SABLE_EVAL_LIVE_MODEL=1`) | PHASE6 |
| Desktop footprint | ~**1.2 GB** RSS cộng dồn khi session `:99` chạy; idle auto-stop 10 phút | PHASE6 W3 |
| Vite baseline sau W7 | ~**866 MB** RSS | PHASE6 W7 |

Đặc điểm sản phẩm so với chatbot chỉ chat:

- Composer **không khóa** khi đang chạy (W7): gửi = chèn (steer), xếp hàng, chạy
  song song (fork), hoặc dừng & gửi; burst ~1,5 s gộp một lượt.
- Công cụ có **jail + duyệt**: `fs_*`, shell bwrap, browser click, desktop
  click/type, Gmail send, calendar write, bridge handoff, code merge.
- Background 24/7 với watchdog (`scripts/headless.mjs` / `startup.sh` +
  `sable-watchdog.sh` trên box).
- Memory học được + hybrid recall; self-eval chỉ **đề xuất**, không tự sửa code.
- Bridge ký HMAC tới một peer (thiết kế cho Grok Bot webhook) — inbound chỉ là
  dữ liệu không tin cậy.

## Hạn chế trung thực (đã ghi)

Từ `docs/FULL-AGENTIC-STATUS.md` «Known gaps» và các wave:

- **Vault chưa lưu được** nếu thiếu `SABLE_VAULT_KEY` → OAuth / bridge trong vault
  **cần cấu hình**.
- **Google connectors** chưa từng sign-in live; Testing mode hết refresh sau 7 ngày;
  Gmail text/plain, sync 2 ngày / 25 thư / 10 phút.
- **Recall paraphrase yếu** với hash embedder (R@5 0.42); cần `OPENAI_API_KEY` hoặc
  local embed / `SABLE_EMBED_*`.
- **Triage production** mặc định rules+heuristic 65% held-out cho đến khi có
  `SABLE_MODEL_LIGHT`.
- **Harden middleware** (CSRF, rate, body) gắn Vite dev; **chưa** gắn Nitro
  production build.
- **Bridge** chỉ phía Sable; peer live **cần cấu hình**; replay nonce trong RAM
  (restart quên nonce; cửa sổ ±300 s vẫn giới hạn).
- Planner bước `agent` một phần dry-run; budget chưa móc mọi field usage provider.
- Video generation cần provider thật; Canvas không tải CDN (CSP).
- `npm audit` còn residual (nodemailer major, better-auth plugin không dùng, …).
- Không Discord/Slack (đã cắt phạm vi Phase 5). Không skill RE/pentest/CTF.

## Đọc tiếp

- Kiến trúc: [02-kien-truc.md](./02-kien-truc.md)
- Cài VPS: [04-cai-dat-vps.md](./04-cai-dat-vps.md)
- Catalog tính năng: [05-tinh-nang.md](./05-tinh-nang.md)
