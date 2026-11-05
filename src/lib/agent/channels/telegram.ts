/**
 * Telegram bot channel: long-poll getUpdates (no webhook, nothing exposed),
 * owner-only allowlist, inline approve/reject buttons. Pure: fetch, clock and
 * handlers are injected so it runs against a local mock in tests.
 * The bot token is only ever placed in the request URL; errors are scrubbed.
 */
import { redactSecrets } from "../memory/redact.ts";

export const TG_MAX_TEXT = 3_900;

export type TgUser = { id: number; is_bot?: boolean; username?: string };
export type TgChat = { id: number; type: string };
export type TgMessage = { message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string };
export type TgCallback = { id: string; from: TgUser; data?: string; message?: TgMessage };
export type TgUpdate = { update_id: number; message?: TgMessage; edited_message?: TgMessage; callback_query?: TgCallback; [key: string]: unknown };

export type Button = { text: string; data: string };

export type TelegramOptions = {
  token: string;
  /** API base, default https://api.telegram.org (tests point it at a local mock). */
  base?: string;
  /** Telegram user ids allowed to talk to Sable (private chats only). */
  owners: ReadonlySet<number>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Long-poll seconds. */
  pollSeconds?: number;
  /** Ignore messages older than this (ms) — e.g. a backlog after downtime. */
  maxAgeMs?: number;
  /** Last processed update id, so a restart does not replay. */
  offset?: number;
  saveOffset?: (offset: number) => void;
  onMessage: (msg: { chatId: number; userId: number; text: string; messageId: number }) => Promise<void> | void;
  onCallback: (cb: { chatId: number; userId: number; data: string; messageId?: number }) => Promise<string> | string;
  log?: (line: string) => void;
};

export function isOwner(owners: ReadonlySet<number>, chat: TgChat | undefined, from: TgUser | undefined) {
  return Boolean(chat && from && !from.is_bot && chat.type === "private" && chat.id === from.id && owners.has(from.id));
}

/** Parse "123, 456" → Set; anything non-numeric is ignored. */
export function parseOwners(raw: string | undefined) {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(/[\s,;]+/)) if (/^\d{1,15}$/.test(part)) out.add(Number(part));
  return out;
}

export function clipText(text: string, max = TG_MAX_TEXT) {
  const clean = redactSecrets(text).text;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export class TelegramChannel {
  private readonly opts: TelegramOptions;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private offset: number;
  private stopper: AbortController | null = null;
  private loop: Promise<void> | null = null;
  dropped = 0;
  handled = 0;
  lastError = "";

  constructor(opts: TelegramOptions) {
    this.opts = opts;
    this.base = (opts.base ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    this.offset = opts.offset ?? 0;
  }

  /** Remove the token from anything that might be logged. */
  scrub(text: string) {
    return redactSecrets(this.opts.token ? text.split(this.opts.token).join("[token]") : text).text;
  }

  private log(line: string) {
    this.opts.log?.(this.scrub(line));
  }

  async api<T = unknown>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.base}/bot${this.opts.token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new Error(this.scrub(`telegram ${method}: ${error instanceof Error ? error.message : String(error)}`));
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
    if (!res.ok || !data.ok) {
      const error = new Error(this.scrub(`telegram ${method}: ${res.status} ${data.description ?? ""}`.trim())) as Error & { status?: number; retryAfter?: number };
      error.status = res.status;
      error.retryAfter = data.parameters?.retry_after;
      throw error;
    }
    return data.result as T;
  }

  send(chatId: number, text: string, buttons?: Button[][]) {
    if (!this.opts.owners.has(chatId)) return Promise.reject(new Error("refusing to send outside the owner allowlist"));
    return this.api<TgMessage>("sendMessage", {
      chat_id: chatId,
      text: clipText(text),
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data.slice(0, 64) }))) } } : {}),
    });
  }

  edit(chatId: number, messageId: number, text: string) {
    if (!this.opts.owners.has(chatId)) return Promise.reject(new Error("refusing to edit outside the owner allowlist"));
    return this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: clipText(text), reply_markup: { inline_keyboard: [] } });
  }

  /** Handle one update. Non-owners are dropped silently (no reply, no detail logged). */
  async handle(update: TgUpdate) {
    const now = this.opts.now?.() ?? Date.now();
    const maxAge = this.opts.maxAgeMs ?? 10 * 60_000;
    if (update.callback_query) {
      const cb = update.callback_query;
      const chat = cb.message?.chat;
      if (!isOwner(this.opts.owners, chat, cb.from) || typeof cb.data !== "string") {
        this.dropped++;
        return;
      }
      let answer = "";
      try {
        answer = await this.opts.onCallback({ chatId: chat!.id, userId: cb.from.id, data: cb.data, messageId: cb.message?.message_id });
      } catch (error) {
        answer = "Không xử lý được.";
        this.log(`callback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.api("answerCallbackQuery", { callback_query_id: cb.id, text: answer.slice(0, 190) }).catch(() => undefined);
      this.handled++;
      return;
    }
    const msg = update.message;
    if (!msg || !isOwner(this.opts.owners, msg.chat, msg.from) || typeof msg.text !== "string" || !msg.text.trim()) {
      this.dropped++;
      return;
    }
    if (now - msg.date * 1000 > maxAge) {
      this.dropped++;
      return;
    }
    this.handled++;
    await this.opts.onMessage({ chatId: msg.chat.id, userId: msg.from!.id, text: msg.text.slice(0, 8_000), messageId: msg.message_id });
  }

  /** One getUpdates round. Returns how many updates came back. */
  async pollOnce(signal?: AbortSignal) {
    const updates = await this.api<TgUpdate[]>(
      "getUpdates",
      { offset: this.offset + 1 || 0, timeout: this.opts.pollSeconds ?? 25, allowed_updates: ["message", "callback_query"] },
      signal,
    );
    for (const update of Array.isArray(updates) ? updates : []) {
      if (typeof update?.update_id !== "number" || update.update_id <= this.offset) continue;
      this.offset = update.update_id;
      this.opts.saveOffset?.(this.offset);
      try {
        await this.handle(update);
      } catch (error) {
        this.log(`update failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return Array.isArray(updates) ? updates.length : 0;
  }

  start() {
    if (this.loop) return;
    const stopper = new AbortController();
    this.stopper = stopper;
    this.loop = (async () => {
      let backoff = 1_000;
      while (!stopper.signal.aborted) {
        try {
          await this.pollOnce(stopper.signal);
          backoff = 1_000;
          this.lastError = "";
        } catch (error) {
          if (stopper.signal.aborted) break;
          const err = error as Error & { status?: number; retryAfter?: number };
          this.lastError = this.scrub(err.message);
          this.log(`poll error: ${this.lastError}`);
          // 401/404 = bad token: stop rather than hammer the API.
          if (err.status === 401 || err.status === 404) break;
          const wait = err.retryAfter ? err.retryAfter * 1000 : backoff;
          backoff = Math.min(30_000, backoff * 2);
          await sleep(wait, stopper.signal);
        }
      }
    })().finally(() => {
      this.loop = null;
    });
  }

  running() {
    return this.loop !== null;
  }

  async stop() {
    this.stopper?.abort();
    await this.loop?.catch(() => undefined);
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}
