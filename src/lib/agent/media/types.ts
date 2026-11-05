export type MediaKind = "image" | "video";
export type MediaStatus = "ready" | "pending" | "failed";

export type MediaItem = {
  id: string;
  kind: MediaKind;
  status: MediaStatus;
  prompt: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Estimated cost charged to the budget meter. */
  usd: number;
  mime?: string;
  bytes?: number;
  /** Workspace-relative path, e.g. media/<id>.png */
  file?: string;
  /** Provider job id (video). */
  requestId?: string;
  /** Provider URL kept only when the local download failed. */
  remoteUrl?: string;
  error?: string;
};

export type ProviderInfo = {
  id: string;
  label: string;
  model: string;
  configured: boolean;
  reason?: string;
};

export type ImageProvider = {
  id: "xai" | "openai-compat";
  label: string;
  base: string;
  key: string;
  model: string;
  style: "xai" | "openai";
};

export type VideoProvider = {
  id: "xai";
  label: string;
  base: string;
  key: string;
  model: string;
};
