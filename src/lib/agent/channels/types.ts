/**
 * Thin channel adapter shared by Telegram and the webhook channel.
 * Keep this small — Discord/Slack are out of scope.
 */
export type ChannelId = "telegram" | "webhook" | "smtp";

export type InboundMessage = {
  channel: ChannelId;
  /** Opaque id from the peer (Telegram chat id, webhook conversation id, …). */
  peerId: string;
  text: string;
  externalId?: string;
};

export type OutboundMessage = {
  peerId?: string;
  text: string;
  /** Optional approval buttons for channels that support them. */
  approvals?: { id: string; summary: string; preview?: string }[];
};

export type ChannelAdapter = {
  id: ChannelId;
  start?(): void;
  stop?(): Promise<void> | void;
  /** Deliver a text (and optional approval ask) to the peer. */
  send?(msg: OutboundMessage): Promise<void>;
};
