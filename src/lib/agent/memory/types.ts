/** Learned memory: durable facts Sable keeps about the user (outside the chat UI). */

export type MemoryKind = "profile" | "journal";
export type MemorySource = "chat" | "job" | "routine" | "telegram" | "tool" | "user" | "import";

export type Memory = {
  id: string;
  /** profile = stable fact / preference / standing instruction; journal = dated event or project state. */
  kind: MemoryKind;
  /** One sentence, already redacted. */
  text: string;
  tags: string[];
  source: MemorySource;
  /** Thread / job / routine id it came from (never message text). */
  sourceRef?: string;
  pinned: boolean;
  /** For journal entries: when it happened / is due (YYYY-MM-DD), if known. */
  eventDate?: string;
  createdAt: number;
  updatedAt: number;
  /** Times it was injected into a prompt. */
  hits: number;
  lastUsedAt?: number;
};

export type MemoryFile = {
  version: 1;
  /** The UI's global switch (SABLE_MEMORY=0 overrides it). */
  enabled: boolean;
  items: Memory[];
};

export const MEMORY_KINDS: readonly MemoryKind[] = ["profile", "journal"];
export const MEMORY_SOURCES: readonly MemorySource[] = ["chat", "job", "routine", "telegram", "tool", "user", "import"];
export const MAX_MEMORY_TEXT = 300;
