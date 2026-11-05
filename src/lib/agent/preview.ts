import type { ChatMessage } from "@/lib/agent/types";

const FENCE = /```html\s*([\s\S]*?)```/gi;

export function latestPage(messages: ChatMessage[]): string | null {
  let html: string | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const match of message.content.matchAll(FENCE)) {
      const body = match[1]?.trim();
      if (body && /<!doctype|<html|<body|<main|<div/i.test(body)) html = body;
    }
  }
  return html;
}
