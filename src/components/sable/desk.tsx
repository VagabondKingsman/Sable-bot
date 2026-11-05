import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowUp,
  ChevronDown,
  Clock,
  Code2,
  Check,
  Copy,
  Download,
  FileDown,
  FolderOpen,
  Globe,
  Terminal,
  AppWindow,
  ImageIcon,
  Lightbulb,
  Menu,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Square,
  Trash2,
  Video,
  Volume2,
  Wrench,
  X,
  PanelRight,
} from "lucide-react";
import { LearnedMemory } from "@/components/sable/memory-panel";
import { DeskSyncPanel } from "@/components/sable/desk-sync-panel";
import { SkillsPanel } from "@/components/sable/skills-panel";
import { ProfilesPanel } from "@/components/sable/profiles-panel";
import { McpPanel } from "@/components/sable/mcp-panel";
import { ConnectorsPanel } from "@/components/sable/connectors-panel";
import { startDeskSync } from "@/lib/agent/desk/client";
import { decideApproval, generateImage, generateVideo, modelInfo, streamReply, voiceStt, voiceTts, type ModelCaps } from "@/lib/agent/client";
import { ScopeApprovalStrip } from "@/components/sable/scope-cards";
import { UserButton, SignedOut } from "@/lib/auth/gates";
import { authEnabled } from "@/lib/auth/client";
import { Link } from "@tanstack/react-router";
import { responsePdf } from "@/lib/agent/pdf";
import { latestCanvas, latestPage } from "@/lib/agent/preview";
import { activeThread, useAgent } from "@/lib/agent/store";
import { DEFAULT_PRESET_ID, findPreset, isDefaultPreset, isDirty, modelsBoundTo } from "@/lib/agent/presets";
import {
  ASPECTS,
  EFFORTS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  MODELS,
  VIDEO_SECONDS,
  type AgentSettings,
  type ApprovalRequest,
  type ChatMessage,
  type TraceStep,
} from "@/lib/agent/types";
import { RichText } from "@/components/sable/rich-text";
import { BackgroundNavButton, BackgroundPanel, type PanelTab } from "@/components/sable/background";
import { CANVAS_OPEN_EVENT, CanvasPane, GuardedFrame, type CanvasOpen } from "@/components/sable/canvas-panel";
import { sanitizeCanvasHtml, withNavGuard } from "@/lib/agent/canvas/render";
import { jobsApi, type JobsCounts } from "@/lib/agent/jobs-client";

const STARTERS = [
  "Tóm tắt tin mới về xAI hôm nay, có nguồn.",
  "Làm một đồng hồ đếm ngược 25 phút, một trang.",
  "Tính lãi kép 10.000 đô ở 5% mỗi năm trong 10 năm. Chạy mã, đừng ước lượng.",
];

const FILE_CAP = 40_000;
const FILE_MAX_BYTES = 512_000;
/** Extensions plus MIME types: some Android pickers grey out files matched by extension only. */
const FILE_ACCEPT = [
  ".txt,.md,.markdown,.json,.csv,.tsv,.log,.py,.js,.mjs,.ts,.tsx,.jsx,.html,.htm,.css,.xml,.svg,.yaml,.yml,.toml,.ini,.sql,.sh",
  "text/*,application/json,application/xml,image/svg+xml,application/x-yaml",
].join(",");

/**
 * The composer (typed text + picked file) lives in sessionStorage so a page
 * reload — or Android discarding the tab while the file picker is open — does
 * not lose it. Cleared on send.
 */
const COMPOSER_KEY = "sable:composer:v1";
type DraftAttachment = { name: string; text: string };

function loadComposer(): { draft: string; attachment: DraftAttachment | null } {
  try {
    if (typeof sessionStorage === "undefined") return { draft: "", attachment: null };
    const raw = sessionStorage.getItem(COMPOSER_KEY);
    if (!raw) return { draft: "", attachment: null };
    const saved = JSON.parse(raw) as { draft?: unknown; attachment?: { name?: unknown; text?: unknown } | null };
    const draft = typeof saved.draft === "string" ? saved.draft : "";
    const file = saved.attachment;
    const attachment =
      file && typeof file.name === "string" && typeof file.text === "string"
        ? { name: file.name.slice(0, 80), text: file.text.slice(0, FILE_CAP) }
        : null;
    return { draft, attachment };
  } catch {
    return { draft: "", attachment: null };
  }
}

function saveComposer(draft: string, attachment: DraftAttachment | null) {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (!draft && !attachment) sessionStorage.removeItem(COMPOSER_KEY);
    else sessionStorage.setItem(COMPOSER_KEY, JSON.stringify({ draft, attachment }));
  } catch {
    // Quota or private mode: the composer still works, it just won't survive a reload.
  }
}

export function Desk() {
  const threads = useAgent((state) => state.threads);
  const activeId = useAgent((state) => state.activeId);
  const settings = useAgent((state) => state.settings);
  const hydrated = useAgent((state) => state.hydrated);
  const newThread = useAgent((state) => state.newThread);
  const selectThread = useAgent((state) => state.selectThread);
  const deleteThread = useAgent((state) => state.deleteThread);
  const patchSettings = useAgent((state) => state.patchSettings);
  const beginTurn = useAgent((state) => state.beginTurn);
  const appendDelta = useAgent((state) => state.appendDelta);
  const setStatus = useAgent((state) => state.setStatus);
  const addNotice = useAgent((state) => state.addNotice);
  const addStep = useAgent((state) => state.addStep);
  const appendThought = useAgent((state) => state.appendThought);
  const addCitation = useAgent((state) => state.addCitation);
  const finishTurn = useAgent((state) => state.finishTurn);
  const setMedia = useAgent((state) => state.setMedia);
  const setApproval = useAgent((state) => state.setApproval);
  const reviseTurn = useAgent((state) => state.reviseTurn);

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<DraftAttachment | null>(null);
  const [reading, setReading] = useState(false);
  const composerLoaded = useRef(false);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const [models, setModels] = useState<readonly string[]>(MODELS);
  const [caps, setCaps] = useState<Record<string, ModelCaps>>({});
  const [imagine, setImagine] = useState(true);
  const [voiceOn, setVoiceOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const mediaChunks = useRef<Blob[]>([]);
  const speakUrl = useRef<string | null>(null);
  /** Web/X/Mã/Ảnh chat are xAI server tools: grey them out for chat-style models. */
  const xaiOnly = caps[settings.model] ? !caps[settings.model].serverTools : false;
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<"chat" | "page">("chat");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState("");
  const [bgOpen, setBgOpen] = useState(false);
  const [bgTab, setBgTab] = useState<PanelTab>("jobs");
  const [bgJob, setBgJob] = useState<string | null>(null);
  const [bgCounts, setBgCounts] = useState<JobsCounts | null>(null);
  const [bgPoke, setBgPoke] = useState(0);
  const busyRef = useRef(false);
  const runRef = useRef<{ threadId: string; abort: () => void } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const field = useRef<HTMLTextAreaElement>(null);
  const thread = activeThread(threads, activeId);
  const page = latestPage(thread?.messages ?? []);
  const [canvasView, setCanvasView] = useState<CanvasOpen>(null);
  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<CanvasOpen>).detail;
      if (detail && typeof detail.id === "string") {
        setCanvasView(detail);
        setMobilePane("page");
      }
    }
    window.addEventListener(CANVAS_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CANVAS_OPEN_EVENT, onOpen);
  }, []);
  const sidePane = Boolean(page || canvasView);
  const threadCanvas = latestCanvas(thread?.messages ?? []);

  useEffect(() => {
    if (!hydrated) return;
    if (!useAgent.getState().threads.length) useAgent.getState().newThread();
    startDeskSync(useAgent as unknown as Parameters<typeof startDeskSync>[0]);
  }, [hydrated]);

  // Restore after mount (not in useState) so SSR and first client render match.
  useEffect(() => {
    const saved = loadComposer();
    if (saved.draft) setDraft((current) => current || saved.draft);
    if (saved.attachment) setAttachment((current) => current ?? saved.attachment);
    composerLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!composerLoaded.current) return;
    saveComposer(draft, attachment);
  }, [draft, attachment]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    void modelInfo(controller.signal)
      .then((info) => {
        setReady(info.ready);
        if (!info.models.length) return;
        setModels(info.models);
        setCaps(info.capabilities);
        setImagine(info.imagine);
        setVoiceOn(Boolean(info.voice?.enabled && info.voice?.configured));
        // A saved grok-* pick is meaningless once only another provider is wired.
        const current = useAgent.getState().settings.model;
        if (!info.models.includes(current)) useAgent.getState().patchSettings({ model: info.models[0] });
      })
      .catch(() => setReady(null));
    return () => controller.abort();
  }, [hydrated]);

  // Badge for background jobs / inbox: light poll (slower when the tab is hidden).
  useEffect(() => {
    if (!hydrated) return;
    let alive = true;
    let timer = 0;
    const controller = new AbortController();
    const run = async () => {
      try {
        const counts = await jobsApi.counts(controller.signal);
        if (alive) setBgCounts(counts);
      } catch {
        /* server busy or restarting; try again later */
      }
      if (alive) timer = window.setTimeout(run, bgOpen ? 3_000 : document.hidden ? 60_000 : 10_000);
    };
    void run();
    return () => {
      alive = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hydrated, bgOpen, bgPoke]);

  useEffect(() => {
    const box = scroller.current;
    if (!box || !stick.current) return;
    box.scrollTop = box.scrollHeight;
  }, [thread?.messages, thread?.updatedAt]);

  useEffect(() => {
    if (!settingsOpen && !navOpen) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setNavOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen, navOpen]);

  function lock(threadId: string, controller: AbortController) {
    busyRef.current = true;
    setBusy(true);
    runRef.current = { threadId, abort: () => controller.abort() };
  }

  function unlock() {
    busyRef.current = false;
    runRef.current = null;
    setBusy(false);
  }

  function settle(threadId: string, assistantId: string) {
    const current = useAgent.getState().threads.find((item) => item.id === threadId);
    const message = current?.messages.find((item) => item.id === assistantId);
    if (message && !message.content && !message.media && !message.steps?.length) {
      finishTurn(threadId, assistantId, "Không có câu trả lời.");
    } else {
      finishTurn(threadId, assistantId);
    }
  }

  async function replyTo(threadId: string, assistantId: string) {
    const snapshot = useAgent.getState();
    const current = snapshot.threads.find((item) => item.id === threadId);
    const history = (current?.messages ?? [])
      .filter((message) => message.id !== assistantId && message.content.trim())
      .map((message) => ({ role: message.role, content: message.content }));
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
    lock(threadId, controller);
    try {
      await streamReply(
        {
          model: snapshot.settings.model,
          effort: snapshot.settings.effort,
          instructions: snapshot.settings.instructions,
          memory: snapshot.settings.memory,
          tools: {
            web: snapshot.settings.web,
            x: snapshot.settings.x,
            code: snapshot.settings.code,
            image: snapshot.settings.image,
            files: snapshot.settings.files !== false,
            fetch: snapshot.settings.fetch !== false,
            shell: snapshot.settings.shell === true,
            browser: snapshot.settings.browser === true,
          },
          messages: history,
          threadId,
          ...(current?.noMemory ? { remember: false } : {}),
        },
        {
          signal,
          onDelta: (delta) => appendDelta(threadId, assistantId, delta),
          onStatus: (status) => setStatus(threadId, assistantId, status),
          onNotice: (notice) => addNotice(threadId, assistantId, notice),
          onStep: (step) => addStep(threadId, assistantId, step),
          onThought: (text) => appendThought(threadId, assistantId, text),
          onCitation: (url) => addCitation(threadId, assistantId, url),
          onImage: (src) => setMedia(threadId, assistantId, { type: "image", src }),
          onApproval: (approval) => setApproval(threadId, assistantId, approval),
        },
      );
      settle(threadId, assistantId);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError" || controller.signal.aborted) finishTurn(threadId, assistantId);
      else if (name === "TimeoutError") finishTurn(threadId, assistantId, "Hết thời gian. Tắt bớt Web, X hoặc Mã rồi gửi lại.");
      else finishTurn(threadId, assistantId, error instanceof Error ? error.message : "Không gửi được.");
    } finally {
      unlock();
    }
  }

  async function send(text: string) {
    const typed = text.trim();
    if (busyRef.current || (!typed && !attachment)) return;
    const file = attachment;
    const content = file ? `${typed}\n\n[Đính kèm ${file.name}]\n${file.text}`.trim() : typed;
    setHint("");
    setDraft("");
    setAttachment(null);
    saveComposer("", null);
    setEditingId(null);
    if (field.current) field.current.style.height = "auto";
    setNavOpen(false);
    let threadId = "";
    let assistantId = "";
    try {
      ({ threadId, assistantId } = beginTurn(content));
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Không lưu được tin.");
      setDraft(typed);
      setAttachment(file);
      return;
    }
    await replyTo(threadId, assistantId);
  }

  /** Hand the thread + draft to the server: it keeps running if this tab closes. */
  async function runInBackground() {
    const typed = draft.trim();
    if (busyRef.current || (!typed && !attachment)) return;
    const file = attachment;
    const content = file ? `${typed}\n\n[Đính kèm ${file.name}]\n${file.text}`.trim() : typed;
    const snapshot = useAgent.getState();
    const history = (activeThread(snapshot.threads, snapshot.activeId)?.messages ?? [])
      .filter((message) => message.content.trim())
      .map((message) => ({ role: message.role, content: message.content }));
    setHint("");
    try {
      const made = await jobsApi.create(
        {
          model: snapshot.settings.model,
          effort: snapshot.settings.effort,
          instructions: snapshot.settings.instructions,
          memory: snapshot.settings.memory,
          tools: {
            web: snapshot.settings.web,
            x: snapshot.settings.x,
            code: snapshot.settings.code,
            image: false,
            files: snapshot.settings.files !== false,
            fetch: snapshot.settings.fetch !== false,
            shell: snapshot.settings.shell === true,
            browser: snapshot.settings.browser === true,
          },
          messages: [...history, { role: "user", content }],
        },
        typed.split("\n")[0].slice(0, 80) || file?.name,
      );
      setDraft("");
      setAttachment(null);
      saveComposer("", null);
      if (field.current) field.current.style.height = "auto";
      setBgPoke((value) => value + 1);
      setBgTab("jobs");
      setBgJob(made.id);
      setBgOpen(true);
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Không chạy nền được.");
    }
  }

  async function decide(threadId: string, messageId: string, approval: ApprovalRequest, approve: boolean) {
    setApproval(threadId, messageId, { ...approval, state: approve ? "approved" : "rejected" });
    try {
      await decideApproval(approval.id, approve);
    } catch (error) {
      setApproval(threadId, messageId, { ...approval, state: "expired" });
      setHint(error instanceof Error ? error.message : "Không gửi được lựa chọn.");
    }
  }

  async function regenerate(userMessageId: string, content: string) {
    const next = content.trim();
    if (busyRef.current || !next) return;
    setHint("");
    setEditingId(null);
    setNavOpen(false);
    let threadId = "";
    let assistantId = "";
    try {
      ({ threadId, assistantId } = reviseTurn(userMessageId, next));
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Không sửa được tin.");
      return;
    }
    await replyTo(threadId, assistantId);
  }

  async function copyMessage(id: string, text: string) {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? "" : current)), 1200);
    } catch {
      setHint("Không chép được. Hãy chọn chữ rồi sao chép.");
    }
  }

  async function exportPdf(prompt: string, answer: string) {
    try {
      const blob = await responsePdf({ prompt, answer });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "sable-phan-hoi.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Không xuất được PDF.");
    }
  }

  function onComposerKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter") return;
    const sendOnEnter = settings.enterToSend !== false;
    const command = event.metaKey || event.ctrlKey;
    if (sendOnEnter) {
      if (event.shiftKey || command) return;
      event.preventDefault();
      void send(draft);
      return;
    }
    if (command) {
      event.preventDefault();
      void send(draft);
    }
  }

  async function runMedia(kind: "image" | "video") {
    const prompt = draft.trim();
    if (busyRef.current) return;
    if (!prompt) {
      setHint(kind === "image" ? "Gõ mô tả vào ô nhắn, rồi bấm Ảnh." : "Gõ mô tả vào ô nhắn, rồi bấm Video.");
      return;
    }
    setHint("");
    setDraft("");
    if (field.current) field.current.style.height = "auto";
    setNavOpen(false);
    const { threadId, assistantId } = beginTurn(prompt, kind === "image" ? "Đang tạo ảnh" : "Đang dựng video");
    const controller = new AbortController();
    lock(threadId, controller);
    try {
      const options = useAgent.getState().settings;
      const src =
        kind === "image"
          ? await generateImage(prompt, controller.signal, options)
          : await generateVideo(prompt, controller.signal, options, () => setStatus(threadId, assistantId, "Đang dựng video"));
      setMedia(threadId, assistantId, { type: kind, src });
      finishTurn(threadId, assistantId);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError" || controller.signal.aborted) finishTurn(threadId, assistantId);
      else if (name === "TimeoutError") finishTurn(threadId, assistantId, "Hết thời gian tạo media.");
      else finishTurn(threadId, assistantId, error instanceof Error ? error.message : "Không tạo được.");
    } finally {
      unlock();
    }
  }

  function stop() {
    runRef.current?.abort();
  }

  function removeThread(id: string) {
    if (runRef.current?.threadId === id) runRef.current.abort();
    deleteThread(id);
  }

  async function toggleMic() {
    if (!voiceOn) {
      setHint("Giọng nói chưa cấu hình (VOICE_API_KEY / OPENAI_API_KEY).");
      return;
    }
    if (recording) {
      mediaRec.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      mediaChunks.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data.size) mediaChunks.current.push(ev.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        mediaRec.current = null;
        const blob = new Blob(mediaChunks.current, { type: mime });
        mediaChunks.current = [];
        if (blob.size < 200) {
          setHint("Không ghi được âm thanh.");
          return;
        }
        void (async () => {
          setReading(true);
          try {
            const buf = new Uint8Array(await blob.arrayBuffer());
            let binary = "";
            for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
            const text = await voiceStt({ audioBase64: btoa(binary), mime, filename: mime.includes("webm") ? "mic.webm" : "mic.m4a" });
            if (text) setDraft((d) => (d ? `${d.trim()} ${text}` : text));
            else setHint("Không nghe được nội dung.");
          } catch (error) {
            setHint(error instanceof Error ? error.message : "Nhận dạng giọng thất bại.");
          } finally {
            setReading(false);
          }
        })();
      };
      mediaRec.current = rec;
      rec.start();
      setRecording(true);
      setHint("Đang nghe… bấm mic lần nữa để dừng.");
    } catch {
      setHint("Không mở được micro (cần quyền mic trên trình duyệt).");
    }
  }

  async function speakText(text: string) {
    if (!voiceOn || !text.trim()) return;
    try {
      if (speakUrl.current) {
        URL.revokeObjectURL(speakUrl.current);
        speakUrl.current = null;
      }
      const url = await voiceTts({ text: text.slice(0, 4_000) });
      speakUrl.current = url;
      const audio = new Audio(url);
      void audio.play();
    } catch (error) {
      setHint(error instanceof Error ? error.message : "Không đọc được câu trả lời.");
    }
  }

    async function onFile(file: File | undefined) {
    if (!file) return;
    if (file.size > FILE_MAX_BYTES) {
      setHint("Chỉ nhận tệp chữ dưới 512 KB.");
      return;
    }
    if (/^(image\/(?!svg)|video\/|audio\/)/.test(file.type) || /\.(pdf|docx?|xlsx?|pptx?|zip|heic|jpe?g|png|gif|webp)$/i.test(file.name)) {
      setHint("Chỉ nhận tệp chữ (txt, md, csv, json, mã nguồn…). Ảnh dùng nút Ảnh.");
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      if (text.includes("\u0000")) {
        setHint("Chỉ nhận tệp chữ. Ảnh dùng nút Ảnh.");
        return;
      }
      if (!text.trim()) {
        setHint("Tệp trống.");
        return;
      }
      setAttachment({ name: (file.name || "tep.txt").slice(0, 80), text: text.slice(0, FILE_CAP) });
      setHint(text.length > FILE_CAP ? "Đã cắt tệp còn 40.000 ký tự." : "");
    } catch {
      setHint("Không đọc được tệp. Thử chọn lại hoặc lưu tệp vào máy trước.");
    } finally {
      setReading(false);
    }
  }

  if (!hydrated || !thread) return <DeskSkeleton />;

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      {navOpen && (
        <button type="button" aria-label="Đóng danh sách" className="fixed inset-0 z-20 bg-bg/70 md:hidden" onClick={() => setNavOpen(false)} />
      )}
      <aside className={"fixed inset-y-0 left-0 z-30 w-72 flex-col border-r border-fg/10 bg-surface p-3 md:static " + (navOpen ? "flex" : "hidden md:flex")}>
        <div className="flex items-center justify-between px-2 py-2">
          <div className="flex items-center gap-2">
            <span aria-hidden className="inline-block size-3 rounded-sm bg-accent" />
            <span className="font-display text-2xl leading-none">Sable</span>
          </div>
          <button
            type="button"
            className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg"
            onClick={() => {
              newThread();
              setNavOpen(false);
            }}
            aria-label="Cuộc mới"
          >
            <Plus className="size-5" />
          </button>
        </div>
        <nav className="mt-2 flex-1 space-y-1 overflow-y-auto" aria-label="Cuộc trò chuyện">
          {threads.map((item) => {
            const selected = item.id === thread.id;
            return (
              <div key={item.id} data-thread-id={item.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    selectThread(item.id);
                    setNavOpen(false);
                  }}
                  className={"min-h-11 flex-1 truncate rounded-xl px-3 text-left text-sm " + (selected ? "bg-fg/10 text-fg" : "text-muted hover:bg-fg/5 hover:text-fg")}
                >
                  {item.title || "Cuộc mới"}
                </button>
                <button
                  type="button"
                  aria-label={`Xóa ${item.title}`}
                  className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg"
                  onClick={() => removeThread(item.id)}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            );
          })}
        </nav>
        {authEnabled && (
          <div className="mt-2 space-y-2 rounded-xl bg-bg/60 px-3 py-3">
            <UserButton />
            <SignedOut>
              <Link
                to="/login"
                className="flex min-h-11 items-center justify-center rounded-xl bg-accent px-3 text-sm font-medium text-ink"
                onClick={() => setNavOpen(false)}
              >
                Đăng nhập Grok OAuth
              </Link>
            </SignedOut>
          </div>
        )}
        <BackgroundNavButton
          unread={bgCounts?.unread ?? 0}
          waiting={bgCounts?.counts.waiting ?? 0}
          active={bgCounts?.counts.active ?? 0}
          onClick={() => {
            setBgTab((bgCounts?.unread ?? 0) > 0 ? "inbox" : "jobs");
            setBgJob(null);
            setBgOpen(true);
            setNavOpen(false);
          }}
        />
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="mt-2 flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg"
        >
          <Settings2 className="size-4" />
          Cách Sable làm việc
        </button>
      </aside>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-fg/10 px-3 py-2 md:px-5">
          <button
            type="button"
            className="relative grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 md:hidden"
            aria-label={(bgCounts?.unread ?? 0) > 0 ? `Mở danh sách (${bgCounts?.unread} mục mới trong Hộp thư)` : "Mở danh sách"}
            onClick={() => setNavOpen(true)}
          >
            <Menu className="size-5" />
            {/* the sidebar (and its inbox badge) is hidden on phones */}
            {(bgCounts?.unread ?? 0) > 0 && (
              <span data-testid="bg-dot" aria-hidden="true" className="absolute right-2 top-2 size-2.5 rounded-full bg-accent" />
            )}
          </button>
          <h1 className="min-w-0 flex-1 truncate font-display text-xl">{thread.title || "Cuộc mới"}</h1>
          {threadCanvas && canvasView?.id !== threadCanvas.id && (
            <button
              type="button"
              className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg"
              onClick={() => {
                setCanvasView({ id: threadCanvas.id });
                setMobilePane("page");
              }}
            >
              <PanelRight className="size-4" /> Canvas
            </button>
          )}
          {sidePane && (
            <button type="button" className="h-11 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg md:hidden" onClick={() => setMobilePane((pane) => (pane === "chat" ? "page" : "chat"))}>
              {mobilePane === "chat" ? "Xem trang" : "Chat"}
            </button>
          )}
          <span className="hidden text-sm text-muted sm:inline">
            {settings.model} · {EFFORTS.find((item) => item.id === settings.effort)?.label}
          </span>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className={"min-w-0 flex-1 flex-col " + (sidePane && mobilePane === "page" ? "hidden md:flex" : "flex")}>
            <div
              ref={scroller}
              className="flex-1 overflow-y-auto px-4 py-6 md:px-8"
              onScroll={(event) => {
                const box = event.currentTarget;
                stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
              }}
            >
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
                {thread.messages.length === 0 && (
                  <div className="flex flex-col gap-6 pt-8">
                    <div>
                      <p className="font-display text-4xl text-balance">Bàn của agent.</p>
                      <p className="mt-3 max-w-md text-muted">
                        Sable tìm web, tìm X, chạy mã Python, rồi trả lời. Trang HTML mở ở cột xem. Ảnh và video dùng nút riêng.
                      </p>
                      {ready === false && <p className="mt-3 text-sm text-accent">Mô hình chưa sẵn sàng trong môi trường này.</p>}
                    </div>
                    <div className="grid gap-2">
                      {STARTERS.map((prompt) => (
                        <button key={prompt} type="button" onClick={() => void send(prompt)} className="rounded-2xl bg-surface px-4 py-3 text-left text-sm leading-relaxed shadow-ring hover:shadow-ring-strong">
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                      <ScopeApprovalStrip />
                {thread.messages.map((message, index) => {
                  const previous = index > 0 ? thread.messages[index - 1] : undefined;
                  const user = message.role === "user" ? message : previous?.role === "user" ? previous : undefined;
                  return (
                    <MessageView
                      key={message.id}
                      message={message}
                      busy={busy}
                      copied={copiedId === message.id}
                      editing={editingId === message.id}
                      onCopy={() => void copyMessage(message.id, message.content)}
                      onEdit={() => setEditingId(message.id)}
                      onCancelEdit={() => setEditingId(null)}
                      onRegenerate={(content) => {
                        if (user) void regenerate(user.id, content || user.content);
                      }}
                      onPdf={() => void exportPdf(user?.content ?? "", message.content)}
                      onSpeak={voiceOn && message.role === "assistant" && message.content ? () => void speakText(message.content) : undefined}
                      onDecide={(approval, approve) => void decide(thread.id, message.id, approval, approve)}
                    />
                  );
                })}
              </div>
            </div>

            <form
              className="border-t border-fg/10 px-3 py-3 md:px-8"
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <ToolChip on={settings.web} unavailable={xaiOnly} label="Web" icon={<Search className="size-4" />} onClick={() => patchSettings({ web: !settings.web })} />
                  <ToolChip on={settings.x} unavailable={xaiOnly} label="X" icon={<X className="size-4" />} onClick={() => patchSettings({ x: !settings.x })} />
                  <ToolChip on={settings.code} unavailable={xaiOnly} label="Mã" icon={<Code2 className="size-4" />} onClick={() => patchSettings({ code: !settings.code })} />
                  <ToolChip on={settings.image} unavailable={xaiOnly} label="Ảnh chat" icon={<ImageIcon className="size-4" />} onClick={() => patchSettings({ image: !settings.image })} />
                  <ToolChip on={settings.files !== false} label="Tệp" icon={<FolderOpen className="size-4" />} onClick={() => patchSettings({ files: settings.files === false })} />
                  <ToolChip on={settings.fetch !== false} label="Tải trang" icon={<Globe className="size-4" />} onClick={() => patchSettings({ fetch: settings.fetch === false })} />
                  <ToolChip on={settings.shell === true} label="Shell" icon={<Terminal className="size-4" />} onClick={() => patchSettings({ shell: settings.shell !== true })} />
                  <ToolChip on={settings.browser === true} label="Browser" icon={<AppWindow className="size-4" />} onClick={() => patchSettings({ browser: settings.browser !== true })} />
                  <button type="button" disabled={busy || !imagine} title={imagine ? undefined : "Ảnh/Video cần khóa xAI"} onClick={() => void runMedia("image")} className="flex h-11 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-fg shadow-ring hover:shadow-ring-strong disabled:opacity-40">
                    <ImageIcon className="size-4" />
                    Ảnh
                  </button>
                  <button type="button" disabled={busy || !imagine} title={imagine ? undefined : "Ảnh/Video cần khóa xAI"} onClick={() => void runMedia("video")} className="flex h-11 items-center gap-2 rounded-xl bg-surface px-3 text-sm text-fg shadow-ring hover:shadow-ring-strong disabled:opacity-40">
                    <Video className="size-4" />
                    Video
                  </button>
                  <label className="ml-auto flex items-center gap-2">
                    <span className="sr-only">Mức suy luận</span>
                    <select
                      value={settings.effort}
                      onChange={(event) => patchSettings({ effort: event.target.value as AgentSettings["effort"] })}
                      className="h-11 rounded-xl bg-surface px-3 text-sm text-fg shadow-ring"
                    >
                      {EFFORTS.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                    <span className="sr-only">Mô hình</span>
                    <select
                      value={settings.model}
                      onChange={(event) => patchSettings({ model: event.target.value })}
                      className="h-11 rounded-xl bg-surface px-3 text-sm text-fg shadow-ring"
                    >
                      {models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {hint && <p className="px-1 text-sm text-muted">{hint}</p>}
                <div className="flex items-center px-1">
                  <button
                    type="button"
                    onClick={() => patchSettings({ enterToSend: settings.enterToSend === false })}
                    className="min-h-11 text-sm text-muted hover:text-fg"
                  >
                    {settings.enterToSend === false ? "Ctrl+Enter để gửi · Enter xuống hàng" : "Enter để gửi · Shift+Enter xuống hàng"}
                  </button>
                </div>
                {attachment && (
                  <div className="flex items-center gap-2 px-1 text-sm text-muted">
                    <Paperclip className="size-4" />
                    <span className="truncate">{attachment.name}</span>
                    <button type="button" className="min-h-11 px-2 hover:text-fg" onClick={() => setAttachment(null)}>
                      Gỡ
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2 rounded-2xl bg-surface p-2 shadow-ring">
                  <button
                    type="button"
                    aria-label={recording ? "Dừng ghi âm" : "Nói"}
                    title={voiceOn ? (recording ? "Dừng ghi âm" : "Nói vào micro") : "Giọng nói chưa cấu hình"}
                    disabled={reading || busy}
                    onClick={() => void toggleMic()}
                    className={`grid size-11 shrink-0 place-items-center rounded-xl ${recording ? "bg-accent text-ink" : "text-muted hover:bg-fg/5 hover:text-fg"} disabled:opacity-40`}
                  >
                    <Mic className="size-4" />
                  </button>
                  <label className="grid size-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg">
                    <span className="sr-only">Đính kèm tệp chữ</span>
                    <Paperclip className="size-4" />
                    <input
                      type="file"
                      form="sable-file-unbound"
                      accept={FILE_ACCEPT}
                      className="sr-only"
                      disabled={reading}
                      onChange={(event) => {
                        const picked = event.target.files?.[0];
                        event.target.value = "";
                        void onFile(picked);
                      }}
                    />
                  </label>
                  <label className="min-w-0 flex-1">
                    <span className="sr-only">Tin nhắn</span>
                    <textarea
                      ref={field}
                      value={draft}
                      rows={1}
                      placeholder="Nhắn cho Sable"
                      className="max-h-40 min-h-11 w-full resize-none bg-transparent px-2 py-2 leading-relaxed outline-none placeholder:text-muted"
                      onChange={(event) => {
                        setDraft(event.target.value);
                        event.target.style.height = "auto";
                        event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
                      }}
                      onKeyDown={onComposerKey}
                    />
                  </label>
                  {busy ? (
                    <button type="button" onClick={stop} aria-label="Dừng" className="grid size-11 shrink-0 place-items-center rounded-xl bg-fg text-bg">
                      <Square className="size-4" />
                    </button>
                  ) : (
                    <>
                    {bgCounts?.enabled !== false && (
                      <button
                        type="button"
                        aria-label="Chạy nền"
                        title="Chạy nền: vẫn chạy khi đóng tab, kết quả vào Hộp thư"
                        disabled={reading || (!draft.trim() && !attachment)}
                        onClick={() => void runInBackground()}
                        className="grid size-11 shrink-0 place-items-center rounded-xl text-muted shadow-ring hover:text-fg disabled:opacity-40"
                      >
                        <Clock className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Gửi"
                      disabled={reading || (!draft.trim() && !attachment)}
                      onClick={() => void send(draft)}
                      className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-ink disabled:opacity-40"
                    >
                      <ArrowUp className="size-5" />
                    </button>
                    </>
                  )}
                </div>
              </div>
            </form>
          </div>
          {canvasView ? (
            <CanvasPane open={canvasView} mobile={mobilePane === "page"} onClose={() => { setCanvasView(null); setMobilePane("chat"); }} />
          ) : (
            page && <PagePane html={page} mobile={mobilePane === "page"} />
          )}
        </div>
      </section>

      {bgOpen && (
        <BackgroundPanel
          tab={bgTab}
          focusJobId={bgJob}
          models={models}
          onTab={setBgTab}
          onFocusJob={setBgJob}
          onClose={() => {
            setBgOpen(false);
            setBgPoke((value) => value + 1);
          }}
        />
      )}
      {settingsOpen && (
        <Settings
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onChange={patchSettings}
          noMemory={Boolean(thread?.noMemory)}
          onNoMemory={(on) => thread && useAgent.getState().setNoMemory(thread.id, on)}
        />
      )}
    </div>
  );
}

function uniqueSources(urls: string[]) {
  const seen = new Set<string>();
  const items: { url: string; label: string }[] = [];
  for (const url of urls) {
    const label = sourceLabel(url);
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({ url, label });
  }
  return items;
}

function sourceLabel(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const parts = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    return parts.length ? `${host}/${parts.join("/")}` : host;
  } catch {
    return url;
  }
}

const GENERIC_STEP = /^(Đang|Đã) (tìm trên web|tìm trên X|chạy mã|tạo ảnh)$/;

function spanLabel(startedAt: number, finishedAt: number) {
  const seconds = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function visibleSearches(steps: TraceStep[]) {
  const webSpecific = steps.some((step) => step.kind === "web" && !GENERIC_STEP.test(step.label));
  const xSpecific = steps.some((step) => step.kind === "x" && !GENERIC_STEP.test(step.label));
  return steps.filter((step) => {
    if (!GENERIC_STEP.test(step.label)) return true;
    if (step.kind === "web" && webSpecific) return false;
    if (step.kind === "x" && xSpecific) return false;
    return true;
  });
}

export function WorkTrail({ message }: { message: ChatMessage }) {
  const steps = message.steps ?? [];
  const ticking = Boolean(message.startedAt) && !message.finishedAt;
  const [now, setNow] = useState(() => Date.now());
  const toggled = useRef(false);
  const [open, setOpen] = useState(ticking);
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);
  useEffect(() => {
    if (!toggled.current) setOpen(ticking && !message.content);
  }, [ticking, message.content]);
  if (!steps.length && !message.status && !message.startedAt) return null;
  const span = message.startedAt ? spanLabel(message.startedAt, message.finishedAt ?? now) : "";
  const summary = span ? `Đã làm việc trong ${span}` : message.status || `Đã làm ${steps.length} việc`;
  const ids = new Set(steps.map((step) => step.id));
  const childrenOf = (id: string) => steps.filter((step) => step.parent === id);
  const rows = trailRows(steps.filter((step) => !step.parent || !ids.has(step.parent)));
  return (
    <div className="mb-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          toggled.current = true;
          setOpen((value) => !value);
        }}
        className="flex min-h-11 items-center gap-2 text-sm text-muted hover:text-fg"
      >
        <ChevronDown className={"size-4 shrink-0 transition " + (open ? "rotate-180" : "")} />
        {summary}
      </button>
      {open && rows.length > 0 && (
        <ol className="mt-1">
          {rows.map((row, index) =>
            row.kind === "search" ? (
              <SearchGroup key={row.id} steps={row.steps} extra={index === rows.findIndex((item) => item.kind === "search") ? message.citations : undefined} last={index === rows.length - 1} />
            ) : (
              <TrailStep key={row.step.id} step={row.step} last={index === rows.length - 1} subSteps={childrenOf(row.step.id)} />
            ),
          )}
        </ol>
      )}
    </div>
  );
}

type TrailRow = { kind: "step"; step: TraceStep } | { kind: "search"; id: string; steps: TraceStep[] };

function trailRows(steps: TraceStep[]): TrailRow[] {
  const rows: TrailRow[] = [];
  let batch: TraceStep[] = [];
  const flush = () => {
    if (!batch.length) return;
    rows.push({ kind: "search", id: batch.map((step) => step.id).join("-"), steps: batch });
    batch = [];
  };
  for (const step of steps) {
    if (step.kind === "web" || step.kind === "x") batch.push(step);
    else {
      flush();
      rows.push({ kind: "step", step });
    }
  }
  flush();
  return rows;
}

function SearchGroup({ steps, extra, last }: { steps: TraceStep[]; extra?: string[]; last: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = visibleSearches(steps);
  const running = shown.some((step) => step.state === "run");
  const known = new Set(shown.flatMap((step) => step.sources ?? []));
  const loose = (extra ?? []).filter((url) => !known.has(url));
  return (
    <li className="relative pl-6">
      {!last && <span className="absolute top-3 bottom-0 left-[7px] w-px bg-fg/15" aria-hidden />}
      <Search className={"absolute top-2 left-0 size-4 " + (running ? "text-accent" : "text-muted")} />
      <button type="button" aria-expanded={open} className="flex min-h-11 w-full items-center gap-2 py-1.5 text-left text-sm text-muted hover:text-fg" onClick={() => setOpen((value) => !value)}>
        <ChevronDown className={"size-3.5 shrink-0 transition " + (open ? "rotate-180" : "-rotate-90")} />
        {running ? "Đang tìm kiếm" : `Đã chạy ${shown.length} tìm kiếm`}
      </button>
      {open && (
        <ul className="mb-2 ml-1 border-l border-fg/10 pl-3">
          {shown.map((step) => (
            <li key={step.id} className="py-1">
              <p className="text-sm text-muted">{step.label}</p>
              <PageLinks urls={step.sources ?? []} />
            </li>
          ))}
          {loose.length > 0 && (
            <li className="py-1">
              <PageLinks urls={loose} />
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function PageLinks({ urls }: { urls: string[] }) {
  const items = uniqueSources(urls);
  if (!items.length) return null;
  return (
    <ul className="mt-1">
      {items.map((item) => (
        <li key={item.url}>
          <a href={item.url} target="_blank" rel="noreferrer" className="block min-h-11 truncate py-1 text-sm text-muted hover:text-fg">
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function TrailStep({ step, last, subSteps = [] }: { step: TraceStep; last: boolean; subSteps?: TraceStep[] }) {
  const [open, setOpen] = useState(step.kind === "think");
  const Icon =
    step.kind === "think" ? Lightbulb : step.kind === "code" ? Code2 : step.kind === "image" ? ImageIcon : step.kind === "tool" ? Wrench : Search;
  return (
    <li className="relative pl-6">
      {!last && <span className="absolute top-3 bottom-0 left-[7px] w-px bg-fg/15" aria-hidden />}
      <Icon className={"absolute top-2 left-0 size-4 " + (step.state === "run" ? "text-accent" : "text-muted")} />
      {step.detail ? (
        <button type="button" className="min-h-11 w-full py-1.5 text-left text-sm text-muted hover:text-fg" onClick={() => setOpen((value) => !value)}>
          {step.label}
        </button>
      ) : (
        <p className="min-h-11 py-2 text-sm text-muted">{step.label}</p>
      )}
      {open && step.detail && (
        <pre className="mb-2 max-h-48 overflow-auto rounded-xl bg-surface px-3 py-2 text-xs leading-relaxed break-all whitespace-pre-wrap text-muted">{step.detail}</pre>
      )}
      {subSteps.length > 0 && (
        <ol className="mb-1 ml-1 border-l border-accent/30 pl-2" aria-label="Các bước của tác tử phụ">
          {subSteps.map((child, index) => (
            <TrailStep key={child.id} step={child} last={index === subSteps.length - 1} />
          ))}
        </ol>
      )}
    </li>
  );
}

function MessageView({
  message,
  busy,
  copied,
  editing,
  onCopy,
  onEdit,
  onCancelEdit,
  onRegenerate,
  onPdf,
  onSpeak,
  onDecide,
}: {
  message: ChatMessage;
  onDecide: (approval: ApprovalRequest, approve: boolean) => void;
  busy: boolean;
  copied: boolean;
  editing: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onRegenerate: (content: string) => void;
  onPdf: () => void;
  onSpeak?: () => void;
}) {
  if (message.role === "user") {
    return (
      <article className="flex flex-col items-end gap-1">
        {editing ? (
          <PromptEditor initial={message.content} busy={busy} onCancel={onCancelEdit} onSubmit={onRegenerate} />
        ) : (
          <UserBubble content={message.content} />
        )}
        {!editing && (
          <div className="flex">
            <IconButton label={copied ? "Đã chép" : "Chép"} onClick={onCopy}>
              <Copy className="size-4" />
            </IconButton>
            <IconButton label="Sửa" disabled={busy} onClick={onEdit}>
              <Pencil className="size-4" />
            </IconButton>
          </div>
        )}
      </article>
    );
  }
  const done = !message.status && Boolean(message.content || message.media);
  return (
    <article className="max-w-full">
      {message.notice && <p className="mb-2 text-sm text-muted">{message.notice}</p>}
      <WorkTrail message={message} />
      {message.approvals?.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} onDecide={(approve) => onDecide(approval, approve)} />
      ))}
      {message.content ? <RichText text={message.content} /> : message.media ? null : <p className="text-muted">{message.status || "Đang viết"}</p>}
      {message.media?.type === "image" && <img src={message.media.src} alt="" className="mt-3 w-full rounded-xl shadow-ring" />}
      {message.media?.type === "video" && <video src={message.media.src} controls playsInline className="mt-3 w-full rounded-xl shadow-ring" />}
      {done && (
        <div className="mt-1 flex">
          <IconButton label={copied ? "Đã chép" : "Chép"} onClick={onCopy}>
            <Copy className="size-4" />
          </IconButton>
          <IconButton label="Tạo lại" disabled={busy} onClick={() => onRegenerate("")}>
            <RotateCcw className="size-4" />
          </IconButton>
          <IconButton label="Xuất PDF" onClick={onPdf}>
            <FileDown className="size-4" />
          </IconButton>
          {onSpeak && (
            <IconButton label="Đọc to" onClick={onSpeak}>
              <Volume2 className="size-4" />
            </IconButton>
          )}
        </div>
      )}
    </article>
  );
}

const APPROVAL_STATE: Record<ApprovalRequest["state"], string> = {
  pending: "Cần bạn duyệt",
  approved: "Đã đồng ý",
  rejected: "Đã từ chối",
  expired: "Hết hạn duyệt",
};

export function ApprovalCard({ approval, onDecide }: { approval: ApprovalRequest; onDecide: (approve: boolean) => void }) {
  const pending = approval.state === "pending";
  return (
    <div className="mb-3 rounded-2xl bg-surface p-3 shadow-ring" role="group" aria-label="Duyệt thao tác ghi">
      <div className="flex items-center gap-2 text-sm">
        <Wrench className="size-4 shrink-0 text-accent" />
        <span className="font-medium">{approval.summary}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {approval.tool} · {APPROVAL_STATE[approval.state]}
      </p>
      {approval.preview && (
        <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-bg px-3 py-2 text-xs leading-relaxed break-all whitespace-pre-wrap text-muted">{approval.preview}</pre>
      )}
      {pending && (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => onDecide(true)} className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-3 text-sm text-ink">
            <Check className="size-4" />
            Đồng ý
          </button>
          <button type="button" onClick={() => onDecide(false)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted shadow-ring hover:text-fg">
            <X className="size-4" />
            Từ chối
          </button>
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-11 place-items-center rounded-xl text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-40">
      {children}
    </button>
  );
}

function PromptEditor({ initial, busy, onCancel, onSubmit }: { initial: string; busy: boolean; onCancel: () => void; onSubmit: (content: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-full max-w-[85%] rounded-2xl bg-surface p-2 shadow-ring">
      <textarea value={value} rows={3} onChange={(event) => setValue(event.target.value)} className="max-h-40 w-full resize-none bg-transparent px-2 py-2 leading-relaxed outline-none" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="min-h-11 rounded-xl px-3 text-sm text-muted hover:text-fg">
          Hủy
        </button>
        <button type="button" disabled={busy || !value.trim()} onClick={() => onSubmit(value)} className="min-h-11 rounded-xl bg-accent px-3 text-sm text-ink disabled:opacity-40">
          Gửi lại
        </button>
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  const file = content.match(/\[Đính kèm ([^\]]+)\]/);
  const body = file ? content.replace(`[Đính kèm ${file[1]}]\n`, "").trim() : content;
  const long = body.length > 800;
  const shown = long && !open ? `${body.slice(0, 800)}…` : body;
  return (
    <div className="max-w-[85%] rounded-2xl bg-accent px-4 py-3 text-ink">
      {file && <p className="mb-1 text-xs font-medium">{file[1]}</p>}
      {shown && <p className="max-h-60 overflow-auto leading-relaxed break-all whitespace-pre-wrap">{shown}</p>}
      {long && (
        <button type="button" className="mt-2 min-h-11 text-sm underline" onClick={() => setOpen((value) => !value)}>
          {open ? "Thu gọn" : "Xem hết tệp"}
        </button>
      )}
    </div>
  );
}

function PagePane({ html, mobile }: { html: string; mobile: boolean }) {
  function download() {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "sable.html";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
  return (
    <aside className={"min-w-0 flex-col border-fg/10 bg-bg md:flex md:w-[46%] md:border-l " + (mobile ? "flex flex-1" : "hidden")}>
      <div className="flex items-center justify-between px-3 py-2">
        <p className="text-sm text-muted">Bản xem</p>
        <button type="button" onClick={download} className="flex h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted hover:bg-fg/5 hover:text-fg">
          <Download className="size-4" />
          Tải
        </button>
      </div>
      <GuardedFrame title="Bản xem" srcDoc={withNavGuard(sanitizeCanvasHtml(html))} className="m-3 mt-0 min-h-0 flex-1 rounded-xl bg-fg shadow-ring" />
    </aside>
  );
}

function ToolChip({
  on,
  label,
  icon,
  onClick,
  unavailable,
}: {
  on: boolean;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  unavailable?: boolean;
}) {
  const lit = on && !unavailable;
  return (
    <button
      type="button"
      aria-pressed={lit}
      onClick={onClick}
      title={unavailable ? "Chỉ chạy trên model xAI (Responses)" : undefined}
      className={
        "flex h-11 items-center gap-2 rounded-xl px-3 text-sm " +
        (lit ? "bg-accent text-ink" : "bg-surface text-muted shadow-ring hover:text-fg") +
        (unavailable ? " opacity-40 line-through" : "")
      }
    >
      {icon}
      {label}
    </button>
  );
}

function Settings({
  settings,
  onClose,
  onChange,
  noMemory,
  onNoMemory,
}: {
  settings: AgentSettings;
  onClose: () => void;
  onChange: (patch: Partial<AgentSettings>) => void;
  noMemory: boolean;
  onNoMemory: (on: boolean) => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/70">
      <button type="button" aria-label="Đóng cài đặt" className="h-full flex-1" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-labelledby="sable-settings-title" className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto bg-surface p-5 shadow-ring">
        <div className="flex items-center justify-between">
          <h2 id="sable-settings-title" className="font-display text-3xl">
            Cách Sable làm việc
          </h2>
          <button type="button" onClick={onClose} aria-label="Đóng" className="grid size-11 place-items-center rounded-xl hover:bg-fg/5">
            <X className="size-5" />
          </button>
        </div>
        <PromptPresets settings={settings} onChange={onChange} />
        <label className="flex flex-col gap-2 text-sm">
          <span className="text-muted">Ghi nhớ</span>
          <textarea
            value={settings.memory}
            onChange={(event) => onChange({ memory: event.target.value })}
            rows={5}
            placeholder="Tên, việc đang làm, cách bạn muốn được trả lời."
            className="rounded-xl bg-bg p-3 leading-relaxed shadow-ring outline-none placeholder:text-muted"
          />
        </label>
        <DeskSyncPanel />
        <ProfilesPanel settings={settings} onChange={onChange} />
        <SkillsPanel />
        <McpPanel />
        <ConnectorsPanel />
        <LearnedMemory noMemory={noMemory} onNoMemory={onNoMemory} />
        <div className="grid grid-cols-2 gap-3">
          <Choice label="Model ảnh" value={settings.imageModel} options={IMAGE_MODELS} onChange={(imageModel) => onChange({ imageModel })} />
          <Choice label="Khung ảnh" value={settings.imageAspect} options={ASPECTS} onChange={(imageAspect) => onChange({ imageAspect })} />
          <Choice label="Nét ảnh" value={settings.imageResolution} options={IMAGE_RESOLUTIONS} onChange={(imageResolution) => onChange({ imageResolution })} />
          <Choice label="Khung video" value={settings.videoAspect} options={ASPECTS} onChange={(videoAspect) => onChange({ videoAspect })} />
          <Choice label="Giây video" value={settings.videoSeconds} options={VIDEO_SECONDS} onChange={(videoSeconds) => onChange({ videoSeconds })} />
        </div>
        <p className="text-sm leading-relaxed text-muted">
          Web, X và mã chạy trên server của mô hình, cùng một lượt. X tắt sẵn vì mỗi lượt tìm tốn hơn. Ảnh chat để mô hình tự vẽ. Nút Ảnh và Video gọi Imagine trực tiếp.
        </p>
      </div>
    </div>
  );
}

function PromptPresets({
  settings,
  onChange,
}: {
  settings: AgentSettings;
  onChange: (patch: Partial<AgentSettings>) => void;
}) {
  const presets = useAgent((state) => state.presets);
  const activePresetId = useAgent((state) => state.activePresetId);
  const modelBindings = useAgent((state) => state.modelBindings);
  const applyPreset = useAgent((state) => state.applyPreset);
  const savePreset = useAgent((state) => state.savePreset);
  const deletePreset = useAgent((state) => state.deletePreset);
  const bindPresetToModel = useAgent((state) => state.bindPresetToModel);
  const [picked, setPicked] = useState(activePresetId ?? DEFAULT_PRESET_ID);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  const state = { presets, activePresetId, modelBindings };
  const active = findPreset(state, activePresetId);
  const pickedPreset = findPreset(state, picked) ?? presets[0];
  const dirty = isDirty(state, settings.instructions);
  const boundHere = !!active && modelBindings[settings.model] === active.id;
  const chips = pickedPreset ? modelsBoundTo(state, pickedPreset.id) : [];
  const canSaveActive = !!active && !isDefaultPreset(active.id) && dirty;

  useEffect(() => {
    if (activePresetId) setPicked(activePresetId);
  }, [activePresetId]);

  function flash(text: string) {
    setNote(text);
    window.setTimeout(() => setNote((current) => (current === text ? "" : current)), 2500);
  }

  function saveNew() {
    try {
      const id = savePreset({ name: name || "Preset mới", body: settings.instructions });
      setNaming(false);
      setName("");
      setPicked(id);
      flash("Đã lưu preset mới.");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Không lưu được.");
    }
  }

  const button = "inline-flex min-h-11 items-center justify-center gap-1 rounded-xl px-3 text-sm shadow-ring hover:text-fg disabled:opacity-40";

  return (
    <section className="flex flex-col gap-3 text-sm" aria-labelledby="sable-prompt-title">
      <div className="flex items-center justify-between">
        <h3 id="sable-prompt-title" className="text-muted">
          Prompt hệ thống
        </h3>
        <span className="text-xs text-muted">
          {active ? `${active.name}${dirty ? " · đã sửa" : ""}` : "Tùy chỉnh, chưa lưu"}
        </span>
      </div>
      <div className="flex gap-2">
        <select
          aria-label="Chọn preset"
          value={pickedPreset?.id ?? ""}
          onChange={(event) => setPicked(event.target.value)}
          className="h-11 min-w-0 flex-1 rounded-xl bg-bg px-3 text-fg shadow-ring"
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={button + " bg-accent text-ink"}
          disabled={!pickedPreset || (pickedPreset.id === activePresetId && !dirty)}
          onClick={() => {
            if (!pickedPreset) return;
            if (dirty && !window.confirm("Bỏ phần đang sửa và nạp preset này?")) return;
            applyPreset(pickedPreset.id);
            flash(`Đã áp dụng “${pickedPreset.name}”.`);
          }}
        >
          Áp dụng
        </button>
        {pickedPreset && !isDefaultPreset(pickedPreset.id) && (
          <button
            type="button"
            aria-label="Xóa preset"
            className={button + " text-muted"}
            onClick={() => {
              if (!window.confirm(`Xóa preset “${pickedPreset.name}”?`)) return;
              deletePreset(pickedPreset.id);
              setPicked(DEFAULT_PRESET_ID);
              flash("Đã xóa preset.");
            }}
          >
            <Trash2 className="size-4" />
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Model đang gắn với preset này">
          {chips.map((model) => (
            <span key={model} className="rounded-full bg-bg px-2.5 py-1 text-xs text-muted shadow-ring">
              {model}
            </span>
          ))}
        </div>
      )}
      <textarea
        aria-label="Hướng dẫn"
        value={settings.instructions}
        onChange={(event) => onChange({ instructions: event.target.value })}
        rows={8}
        className="rounded-xl bg-bg p-3 leading-relaxed shadow-ring outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button + " text-muted"}
          disabled={!canSaveActive}
          title={active && isDefaultPreset(active.id) ? "Preset mặc định chỉ đọc. Hãy lưu thành preset mới." : undefined}
          onClick={() => {
            if (!active) return;
            savePreset({ id: active.id, name: active.name, body: settings.instructions });
            flash("Đã lưu vào preset hiện tại.");
          }}
        >
          Lưu
        </button>
        <button type="button" className={button + " text-muted"} onClick={() => setNaming((open) => !open)}>
          <Plus className="size-4" />
          Lưu thành mới
        </button>
        <button
          type="button"
          className={button + " text-muted"}
          onClick={() => {
            if (dirty && !window.confirm("Bỏ phần đang sửa và nạp prompt mặc định?")) return;
            applyPreset(DEFAULT_PRESET_ID);
            flash("Đã nạp prompt mặc định.");
          }}
        >
          <RotateCcw className="size-4" />
          Đặt lại mặc định
        </button>
      </div>
      {naming && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            saveNew();
          }}
        >
          <input
            autoFocus
            aria-label="Tên preset"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tên preset"
            className="h-11 min-w-0 flex-1 rounded-xl bg-bg px-3 shadow-ring outline-none placeholder:text-muted"
          />
          <button type="submit" className={button + " bg-accent text-ink"}>
            Lưu
          </button>
        </form>
      )}
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5"
          checked={boundHere}
          disabled={!active || (dirty && !boundHere)}
          onChange={(event) => {
            if (!active) return;
            bindPresetToModel(settings.model, event.target.checked ? active.id : null);
            flash(event.target.checked ? `Đã gắn “${active.name}” với ${settings.model}.` : `Đã bỏ gắn ${settings.model}.`);
          }}
        />
        <span>
          Gắn với model hiện tại <span className="text-muted">({settings.model})</span>
        </span>
      </label>
      <p className="text-xs leading-relaxed text-muted" aria-live="polite">
        {note ||
          (dirty && active
            ? "Có thay đổi chưa lưu. Lưu trước khi gắn với model."
            : "Đổi model sẽ tự nạp preset đã gắn với model đó.")}
      </p>
    </section>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <select
        value={String(value)}
        onChange={(event) => {
          const next = options.find((item) => String(item) === event.target.value);
          if (next !== undefined) onChange(next);
        }}
        className="h-11 rounded-xl bg-bg px-3 text-fg shadow-ring"
      >
        {options.map((item) => (
          <option key={String(item)} value={String(item)}>
            {String(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

function DeskSkeleton() {
  return (
    <div className="flex h-dvh bg-bg text-fg">
      <div className="hidden w-72 border-r border-fg/10 bg-surface md:block" />
      <div className="flex flex-1 flex-col gap-4 px-8 py-10">
        <div className="h-8 w-40 rounded-xl bg-surface" />
        <div className="mt-8 h-10 w-64 rounded-xl bg-surface" />
        <div className="h-16 max-w-md rounded-2xl bg-surface" />
      </div>
    </div>
  );
}
