/**
 * Owner-only email notifications over SMTP (nodemailer). The recipient is
 * fixed by configuration (one address); nothing the model writes can change it.
 */
import { redactSecrets } from "../memory/redact.ts";

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  /** Allow a plain-text connection (local mock / LAN relay only). */
  allowInsecure?: boolean;
};

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

/** Read SABLE_SMTP_*; null when not configured or invalid (reason in `error`). */
export function smtpConfigFrom(env: Record<string, string | undefined>): { config: SmtpConfig | null; error?: string } {
  const host = env.SABLE_SMTP_HOST?.trim();
  if (!host) return { config: null };
  const to = env.SABLE_SMTP_TO?.trim() ?? "";
  const from = env.SABLE_SMTP_FROM?.trim() || env.SABLE_SMTP_USER?.trim() || "";
  if (!EMAIL.test(to)) return { config: null, error: "SABLE_SMTP_TO phải là đúng một địa chỉ email" };
  if (!EMAIL.test(from)) return { config: null, error: "SABLE_SMTP_FROM không hợp lệ" };
  const port = Number(env.SABLE_SMTP_PORT) || 587;
  const secure = (env.SABLE_SMTP_SECURE ?? (port === 465 ? "1" : "0")).trim() === "1";
  return {
    config: {
      host,
      port,
      secure,
      user: env.SABLE_SMTP_USER?.trim() || undefined,
      pass: env.SABLE_SMTP_PASS || undefined,
      from,
      to,
      allowInsecure: (env.SABLE_SMTP_ALLOW_INSECURE ?? "").trim() === "1",
    },
  };
}

export type Mail = { subject: string; text: string };

export function cleanMail(mail: Mail): Mail {
  const subject = redactSecrets(mail.subject).text.replace(/[\r\n]+/g, " ").slice(0, 160);
  const text = redactSecrets(mail.text).text.slice(0, 50_000);
  return { subject, text };
}

type Transport = { sendMail(mail: Record<string, unknown>): Promise<unknown>; close?: () => void };

export class SmtpChannel {
  private readonly config: SmtpConfig;
  private transport: Transport | null = null;
  private readonly make?: (config: SmtpConfig) => Promise<Transport>;
  sent = 0;
  lastError = "";

  constructor(config: SmtpConfig, make?: (config: SmtpConfig) => Promise<Transport>) {
    this.config = config;
    this.make = make;
  }

  get to() {
    return this.config.to;
  }

  private async transportFor(): Promise<Transport> {
    if (this.transport) return this.transport;
    if (this.make) this.transport = await this.make(this.config);
    else {
      const nodemailer = (await import("nodemailer")).default;
      this.transport = nodemailer.createTransport({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        requireTLS: !this.config.secure && !this.config.allowInsecure,
        ignoreTLS: Boolean(this.config.allowInsecure) && !this.config.secure,
        auth: this.config.user ? { user: this.config.user, pass: this.config.pass ?? "" } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      }) as unknown as Transport;
    }
    return this.transport;
  }

  /** Send to the configured owner address only. Never throws; returns ok. */
  async notify(mail: Mail) {
    const clean = cleanMail(mail);
    try {
      const transport = await this.transportFor();
      await transport.sendMail({ from: this.config.from, to: this.config.to, subject: clean.subject, text: clean.text });
      this.sent++;
      this.lastError = "";
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = redactSecrets(this.config.pass ? message.split(this.config.pass).join("[pass]") : message).text.slice(0, 200);
      return false;
    }
  }

  close() {
    this.transport?.close?.();
    this.transport = null;
  }
}
