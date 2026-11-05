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

const CANVAS_DONE = /canvas id=(c_[a-z0-9]{8,32}) version=(\d+)/;

/** The newest canvas written by canvas_write in this thread (from its trace step). */
export function latestCanvas(messages: ChatMessage[]): { id: string; version: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const steps = messages[i]?.steps ?? [];
    for (let j = steps.length - 1; j >= 0; j--) {
      const step = steps[j];
      if (step?.state !== "done" || (step.tool && step.tool !== "canvas_write")) continue;
      const m = CANVAS_DONE.exec(step.detail ?? "");
      if (m) return { id: m[1] as string, version: Number(m[2]) };
    }
  }
  return null;
}
