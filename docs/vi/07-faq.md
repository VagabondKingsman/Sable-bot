# 07 · FAQ & thuật ngữ

## Câu hỏi thường gặp

**Sable có phải chatbot đa người dùng không?**  
Không. Đây là desk agent **một operator**. Telegram chỉ owner id; webhook chỉ
`peerId` cấu hình.

**Chạy hai instance chung một data dir được không?**  
Không — `docs/DEPLOY.md` yêu cầu một process sở hữu `$SABLE_DATA_DIR`.

**Thiếu API key thì sao?**  
UI vẫn lên; chat/media trả **503**. `startup.sh` ghi cảnh báo (không in giá trị).

**Tại sao POST từ domain khác bị 403?**  
CSRF/origin (`SABLE_TRUSTED_ORIGINS`). Machine HMAC endpoints được exempt một
phần — xem harden + WEBHOOK/BRIDGE docs.

**Telegram có webhook server không?**  
Không. Sable **long-poll** Bot API; không cần mở port cho Telegram.

**Tin nhắn lúc Sable đang làm việc thì sao (W7)?**  
Mặc định **steer** vào lượt đang chạy tại điểm an toàn (sau tool, trước model
bước sau). Menu: xếp hàng, chạy song song (fork), dừng & gửi. Telegram tương tự
+ "Đã nhận ✓" nếu > ~5 s.

**Background có tự gửi email/bridge không?**  
Không. Gmail send / bridge handoff / desktop action / code apply cần owner web
(hoặc bị từ chối trước khi hiện thẻ).

**Vault báo not-configured?**  
Thiếu `SABLE_VAULT_KEY` — **cần cấu hình**. Không có key thì không lưu OAuth/
bridge trong vault.

**Recall kém với câu đồng nghĩa?**  
Hash embedder lexical: paraphrase R@5 **0.42** (W5). Cần embeddings thật
(`OPENAI_API_KEY` / `SABLE_EMBED_*`) — **cần cấu hình**.

**Triage chỉ ~65%?**  
Held-out rules+heuristic. Đặt `SABLE_MODEL_LIGHT` (đo 93.3% trên cùng bộ với
grok-4.5 tier) — **cần cấu hình**.

**Discord / Slack?**  
Không có trong phạm vi (Phase 5 đã cắt). Dùng Telegram + webhook.

**Production build Nitro?**  
`npm run build` tồn tại (preset vercel). Harden CSRF/rate **hiện gắn Vite
dev**. Checklist VPS ghi rõ gap này — hoặc chạy headless `vite dev` như box.

**Làm sao biết version / wave?**  
`docs/FULL-AGENTIC-STATUS.md` + `docs/PHASE6-PROGRESS.md` (W7). Commit git trên
`main`.

**Eval đỏ thì deploy?**  
Không khuyến nghị. Sửa đến khi `tsc`, `npm test`, `eval:wN` liên quan xanh.

**Share Canvas người ngoài mở được không?**  
URL `/s/<token>` readonly; trên ngrok hiện vẫn sau basic auth trừ khi bạn
exempt path (CANVAS-SHARE.md) — quyết định của owner.

## Thuật ngữ

| Thuật ngữ | Nghĩa trong Sable |
|---|---|
| Owner | Chủ sở hữu duy nhất được duyệt hành động nhạy cảm |
| Desk | UI chat chính + đồng bộ `desk.json` |
| Turn | Một lượt agent (W7: có id, SSE, steer/queue) |
| Steer | Chèn tin owner vào lượt đang chạy tại safe point |
| Queue | Xếp tin chạy sau lượt hiện tại (FIFO) |
| Fork | Chạy song song dạng job nền; trả lời threaded |
| Safe point | Sau khi gắn kết quả tool, trước lần gọi model kế |
| Heavy slot | Giới hạn agent nặng đồng thời (desktop/research/code/spawn) |
| ScopeGate | Cổng quyền ACT; tắt = fail-closed deny |
| Vault | Kho AES-GCM tên bí mật; API không trả giá trị OAuth |
| Untrusted | Dữ liệu ngoài — không được coi là lệnh hệ thống |
| Kill switch | Biến `SABLE_*=0` tắt module |
| bwrap | bubblewrap jail |
| SSRF guard | Chặn fetch vào IP private/metadata/credential URL |
| Routine | Job định kỳ hoặc builtin (brief, nightly-eval) |
| Trigger | Webhook fire hoặc watch URL/RSS |
| Bridge | Kênh ký `sable.bridge.v1` tới một peer |
| Canvas | Trang HTML sandbox trong CSP chặt |
| Hybrid recall | BM25 + vector + recency |
| Initiator | user / routine / trigger / agent / subagent / channel |
| ICT | Asia/Saigon, UTC+7 — múi giờ brief/routine mặc định |

## Liên kết nhanh

- Mục lục: [README.md](./README.md)
- Cài VPS: [04-cai-dat-vps.md](./04-cai-dat-vps.md)
- Bảo mật: [06-bao-mat-van-hanh.md](./06-bao-mat-van-hanh.md)
- Protocol EN: `docs/WEBHOOK-API.md`, `docs/BRIDGE-PROTOCOL.md`, `docs/OAUTH-SETUP.md`
