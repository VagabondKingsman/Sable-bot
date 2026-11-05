import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mergeTrace } from "@/lib/agent/harness";
import { DEFAULT_SETTINGS, type AgentSettings, type ApprovalRequest, type ChatMessage, type Thread, type TraceStep } from "@/lib/agent/types";
import {
  applyPreset as applyPresetTo,
  bindPresetToModel as bindPresetIn,
  defaultPreset,
  deletePreset as deletePresetFrom,
  DEFAULT_PRESET_ID,
  migratePresets,
  presetForModel,
  savePreset as savePresetIn,
  staleInstructions,
  type PresetState,
  type PromptPreset,
} from "@/lib/agent/presets";

export { staleInstructions };

type AgentState = {
  threads: Thread[];
  activeId: string;
  settings: AgentSettings;
  hydrated: boolean;
  setHydrated: () => void;
  newThread: () => string;
  selectThread: (id: string) => void;
  deleteThread: (id: string) => void;
  patchSettings: (patch: Partial<AgentSettings>) => void;
  presets: PromptPreset[];
  activePresetId: string | null;
  modelBindings: Record<string, string>;
  listPresets: () => PromptPreset[];
  savePreset: (input: { id?: string; name: string; body: string }) => string;
  deletePreset: (id: string) => void;
  applyPreset: (id: string) => void;
  bindPresetToModel: (modelId: string, presetId: string | null) => void;
  setNoMemory: (threadId: string, on: boolean) => void;
  beginTurn: (content: string, status?: string) => { threadId: string; assistantId: string };
  reviseTurn: (userMessageId: string, content: string, status?: string) => { threadId: string; assistantId: string };
  appendDelta: (threadId: string, messageId: string, text: string) => void;
  setStatus: (threadId: string, messageId: string, status: string) => void;
  addNotice: (threadId: string, messageId: string, text: string) => void;
  addStep: (threadId: string, messageId: string, step: TraceStep) => void;
  appendThought: (threadId: string, messageId: string, text: string) => void;
  addCitation: (threadId: string, messageId: string, url: string) => void;
  setApproval: (threadId: string, messageId: string, approval: ApprovalRequest) => void;
  setMedia: (threadId: string, messageId: string, media: ChatMessage["media"]) => void;
  finishTurn: (threadId: string, messageId: string, error?: string) => void;
  /** W7: append a message to a thread (user message sent while a turn runs, assistant placeholder). */
  addMessage: (threadId: string, message: ChatMessage) => void;
  patchMessage: (threadId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  /** W7: keep the running answer below the latest owner message (steer / burst). */
  moveToEnd: (threadId: string, messageId: string) => void;
  /** W7: the server restarted a turn (burst coalescing) or a stream is replayed from seq 0. */
  resetMessage: (threadId: string, messageId: string, status?: string) => void;
  /** W7: insert or update a threaded reply (fork / late result) by id. */
  upsertMessage: (threadId: string, message: ChatMessage) => void;
};

export function newMessageId() {
  return crypto.randomUUID();
}

const MAX_THREADS = 40;

function withoutStatus(threads: Thread[]) {
  return threads.map((thread) => ({
    ...thread,
    messages: thread.messages.map((message) => {
      const media =
        message.media?.src.startsWith("data:") && message.media.src.length > 120_000 ? undefined : message.media;
      const approvals = message.approvals?.map((item) => (item.state === "pending" ? { ...item, state: "expired" as const } : item));
      return { ...message, status: undefined, media, approvals };
    }),
  }));
}

function uid() {
  return crypto.randomUUID();
}

function blankThread(): Thread {
  return { id: uid(), title: "Cuộc mới", updatedAt: Date.now(), messages: [] };
}

function touch(thread: Thread, messages: ChatMessage[], title?: string): Thread {
  return { ...thread, title: title ?? thread.title, updatedAt: Date.now(), messages };
}

function mapThread(threads: Thread[], id: string, edit: (thread: Thread) => Thread) {
  return threads.map((thread) => (thread.id === id ? edit(thread) : thread));
}

function titleFrom(content: string) {
  const file = content.match(/^\[Đính kèm ([^\]]+)\]/);
  if (file?.[1]) return file[1].slice(0, 42);
  const line = content.split("\n")[0]?.trim().replace(/\s+/g, " ") ?? "";
  return line.slice(0, 42) || "Cuộc mới";
}

const memoryStorage = createJSONStorage(() => ({
  getItem: (name) => (typeof localStorage === "undefined" ? null : localStorage.getItem(name)),
  setItem: (name, value) => queueStorage(name, value),
  removeItem: (name) => {
    pendingName = "";
    if (typeof localStorage !== "undefined") localStorage.removeItem(name);
  },
}));

let pendingName = "";
let pendingValue = "";
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let burstStart = 0;
let burstWrites = 0;

function flushStorage() {
  if (!pendingName || typeof localStorage === "undefined") return;
  const name = pendingName;
  const value = pendingValue;
  pendingName = "";
  try {
    localStorage.setItem(name, value);
  } catch {
    /* quota full: keep the session in memory */
  }
}

function queueStorage(name: string, value: string) {
  pendingName = name;
  pendingValue = value;
  const now = Date.now();
  if (now - burstStart > 300) {
    burstStart = now;
    burstWrites = 0;
  }
  burstWrites += 1;
  clearTimeout(flushTimer);
  if (burstWrites === 1) flushStorage();
  else flushTimer = setTimeout(flushStorage, 300);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushStorage);
}

export const useAgent = create<AgentState>()(
  persist(
    (set, get) => ({
      threads: [],
      activeId: "",
      settings: DEFAULT_SETTINGS,
      hydrated: false,
      setHydrated: () => set({ hydrated: true }),
      newThread: () => {
        const thread = blankThread();
        set((state) => ({ threads: [thread, ...state.threads].slice(0, MAX_THREADS), activeId: thread.id }));
        return thread.id;
      },
      selectThread: (id) => set({ activeId: id }),
      setNoMemory: (threadId, on) =>
        set((state) => ({ threads: state.threads.map((thread) => (thread.id === threadId ? { ...thread, noMemory: on || undefined } : thread)) })),
      deleteThread: (id) =>
        set((state) => {
          const threads = state.threads.filter((thread) => thread.id !== id);
          if (!threads.length) {
            const thread = blankThread();
            return { threads: [thread], activeId: thread.id };
          }
          return { threads, activeId: state.activeId === id ? threads[0].id : state.activeId };
        }),
      patchSettings: (patch) =>
        set((state) => {
          const settings = { ...state.settings, ...patch };
          // Switching model loads the preset bound to it, if any.
          const bound =
            patch.model !== undefined && patch.model !== state.settings.model
              ? presetForModel(presetSlice(state), settings.instructions, patch.model)
              : null;
          if (!bound) return { settings };
          return { settings: { ...settings, instructions: bound.instructions }, activePresetId: bound.activePresetId };
        }),
      presets: [defaultPreset()],
      activePresetId: DEFAULT_PRESET_ID,
      modelBindings: {},
      listPresets: () => get().presets,
      savePreset: (input) => {
        const result = savePresetIn(presetSlice(get()), input);
        set((state) => ({ ...result.state, settings: { ...state.settings, instructions: input.body } }));
        return result.id;
      },
      deletePreset: (id) => set((state) => deletePresetFrom(presetSlice(state), id)),
      applyPreset: (id) =>
        set((state) => {
          const next = applyPresetTo(presetSlice(state), state.settings.instructions, id);
          return { activePresetId: next.activePresetId, settings: { ...state.settings, instructions: next.instructions } };
        }),
      bindPresetToModel: (modelId, presetId) => set((state) => bindPresetIn(presetSlice(state), modelId, presetId)),
      beginTurn: (content, status = "Đang viết") => {
        const assistantId = uid();
        let threadId = "";
        set((state) => {
          const threads = state.threads.length ? state.threads : [blankThread()];
          const current = threads.find((thread) => thread.id === state.activeId) ?? threads[0];
          threadId = current.id;
          const title = current.messages.length === 0 ? titleFrom(content) : current.title;
          const messages: ChatMessage[] = [
            ...current.messages,
            { id: uid(), role: "user", content },
            { id: assistantId, role: "assistant", content: "", status, startedAt: Date.now() },
          ];
          return {
            activeId: current.id,
            threads: mapThread(threads, current.id, (thread) => touch(thread, messages, title)),
          };
        });
        return { threadId, assistantId };
      },
      reviseTurn: (userMessageId, content, status = "Đang viết") => {
        const assistantId = uid();
        let threadId = "";
        let missing = false;
        set((state) => {
          const threads = state.threads.length ? state.threads : [blankThread()];
          const current = threads.find((thread) => thread.id === state.activeId) ?? threads[0];
          const index = current.messages.findIndex((message) => message.id === userMessageId && message.role === "user");
          if (index < 0) {
            missing = true;
            return state;
          }
          threadId = current.id;
          const messages: ChatMessage[] = [
            ...current.messages.slice(0, index),
            { ...current.messages[index], content },
            { id: assistantId, role: "assistant", content: "", status, startedAt: Date.now() },
          ];
          return {
            activeId: current.id,
            threads: mapThread(threads, current.id, (thread) => touch(thread, messages)),
          };
        });
        if (missing) throw new Error("Không thấy tin để sửa.");
        return { threadId, assistantId };
      },
      appendDelta: (threadId, messageId, text) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(
              thread,
              thread.messages.map((message) =>
                message.id === messageId ? { ...message, content: message.content + text } : message,
              ),
            ),
          ),
        })),
      setStatus: (threadId, messageId, status) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) => (message.id === messageId ? { ...message, status } : message)),
          })),
        })),
      addNotice: (threadId, messageId, text) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === messageId ? { ...message, notice: message.notice ? message.notice : text } : message,
            ),
          })),
        })),
      addStep: (threadId, messageId, step) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) => {
              if (message.id !== messageId) return message;
              const steps = message.steps ?? [];
              return { ...message, steps: mergeTrace(steps, step) };
            }),
          })),
        })),
      appendThought: (threadId, messageId, text) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) => {
              if (message.id !== messageId || !text) return message;
              const steps = message.steps ?? [];
              const prior = steps.find((step) => step.id === "thought");
              const priorDetail = prior?.detail ?? "";
              const detail =
                priorDetail && (text === priorDetail || text.startsWith(priorDetail) || priorDetail.endsWith(text))
                  ? text.length >= priorDetail.length
                    ? text
                    : priorDetail
                  : `${priorDetail}${text}`.slice(-4_000);
              const step: TraceStep = { id: "thought", kind: "think", label: "Suy luận", detail, state: "run" };
              const next = prior ? steps.map((item) => (item.id === "thought" ? step : item)) : [...steps, step];
              return { ...message, steps: next };
            }),
          })),
        })),
      addCitation: (threadId, messageId, url) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) => {
              if (message.id !== messageId) return message;
              const steps = message.steps ?? [];
              let index = -1;
              for (let cursor = steps.length - 1; cursor >= 0; cursor -= 1) {
                if (steps[cursor].kind === "web" || steps[cursor].kind === "x") {
                  index = cursor;
                  break;
                }
              }
              if (index < 0) {
                return {
                  ...message,
                  steps: [...steps, { id: "browse", kind: "web", label: "Đã tìm trên web", state: "done", sources: [url] }],
                };
              }
              const step = steps[index];
              const sources = step.sources ?? [];
              if (sources.includes(url) || sources.length >= 8) return message;
              const next = steps.slice();
              next[index] = { ...step, sources: [...sources, url] };
              return { ...message, steps: next };
            }),
          })),
        })),
      setApproval: (threadId, messageId, approval) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => ({
            ...thread,
            messages: thread.messages.map((message) => {
              if (message.id !== messageId) return message;
              const list = message.approvals ?? [];
              const prior = list.find((item) => item.id === approval.id);
              const merged = prior ? { ...prior, ...approval, preview: approval.preview ?? prior.preview } : approval;
              const approvals = prior ? list.map((item) => (item.id === approval.id ? merged : item)) : [...list, merged].slice(-10);
              return { ...message, approvals };
            }),
          })),
        })),
      setMedia: (threadId, messageId, media) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(
              thread,
              thread.messages.map((message) =>
                message.id === messageId ? { ...message, media, status: undefined } : message,
              ),
            ),
          ),
        })),
      addMessage: (threadId, message) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(thread, [...thread.messages, message], thread.messages.length === 0 && message.role === "user" ? titleFrom(message.content) : undefined),
          ),
        })),
      patchMessage: (threadId, messageId, patch) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(thread, thread.messages.map((message) => (message.id === messageId ? { ...message, ...patch } : message))),
          ),
        })),
      moveToEnd: (threadId, messageId) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => {
            const found = thread.messages.find((message) => message.id === messageId);
            if (!found || thread.messages[thread.messages.length - 1]?.id === messageId) return thread;
            return touch(thread, [...thread.messages.filter((message) => message.id !== messageId), found]);
          }),
        })),
      resetMessage: (threadId, messageId, status = "Đang viết") =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(
              thread,
              thread.messages.map((message) =>
                message.id === messageId
                  ? { ...message, content: "", steps: undefined, citations: undefined, notice: undefined, media: undefined, approvals: undefined, finishedAt: undefined, status }
                  : message,
              ),
            ),
          ),
        })),
      upsertMessage: (threadId, message) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) => {
            const exists = thread.messages.some((item) => item.id === message.id);
            const messages = exists ? thread.messages.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...thread.messages, message];
            return touch(thread, messages);
          }),
        })),
      finishTurn: (threadId, messageId, error) =>
        set((state) => ({
          threads: mapThread(state.threads, threadId, (thread) =>
            touch(
              thread,
              thread.messages.flatMap((message) => {
                if (message.id !== messageId) return [message];
                const content = error && !message.content ? error : message.content;
                const steps = message.steps?.map((step) => ({ ...step, state: "done" as const }));
                const approvals = message.approvals?.map((item) =>
                  item.state === "pending" ? { ...item, state: "expired" as const } : item,
                );
                const next = {
                  ...message,
                  approvals,
                  content,
                  status: undefined,
                  steps,
                  finishedAt: message.finishedAt ?? Date.now(),
                };
                if (!next.content && !next.media && !next.steps?.length) return [];
                return [next];
              }),
            ),
          ),
        })),
    }),
    {
      name: "sable-desk",
      storage: memoryStorage,
      partialize: (state) => ({
        threads: withoutStatus(state.threads).slice(0, MAX_THREADS),
        activeId: state.activeId,
        settings: state.settings,
        presets: state.presets,
        activePresetId: state.activePresetId,
        modelBindings: state.modelBindings,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AgentState> | undefined;
        const savedThreads = saved?.threads?.length ? withoutStatus(saved.threads) : [blankThread()];
        const activeId = savedThreads.some((thread) => thread.id === saved?.activeId)
          ? (saved?.activeId as string)
          : savedThreads[0].id;
        const savedSettings = saved?.settings;
        const { instructions, ...presetState } = migratePresets(saved, savedSettings?.instructions ?? "");
        return {
          ...current,
          ...presetState,
          threads: savedThreads,
          activeId,
          settings: { ...DEFAULT_SETTINGS, ...savedSettings, instructions },
          hydrated: false,
        };
      },
      onRehydrateStorage: () => (state) => {
        if (state) state.setHydrated();
        else useAgent.setState({ hydrated: true });
      },
    },
  ),
);

function presetSlice(state: PresetState): PresetState {
  return { presets: state.presets, activePresetId: state.activePresetId, modelBindings: state.modelBindings };
}

export function activeThread(threads: Thread[], activeId: string) {
  return threads.find((thread) => thread.id === activeId) ?? threads[0];
}
