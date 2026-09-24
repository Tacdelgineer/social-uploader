export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;
export const R2_STORAGE_CAP_BYTES = 8_000_000_000;

export const VIDEO_CONTENT_TYPES = ["video/mp4"] as const;
export const THUMBNAIL_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const YOUTUBE_THUMBNAIL_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;

export type AssetKind = "video" | "thumbnail";
export type Platform = "youtube" | "instagram" | "tiktok";
export type JobStatus =
  | "uploading"
  | "processing"
  | "scheduled"
  | "failed"
  | "cancelled"
  | "uploading_to_youtube"
  | "scheduled_on_youtube";

export interface UploadFileRequest {
  kind: AssetKind;
  fileName: string;
  contentType: string;
  size: number;
}

export interface PresignRequest {
  jobId: string;
  files: UploadFileRequest[];
}

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export interface PresignResponse {
  uploads: Record<AssetKind, PresignedUpload>;
  capacity: {
    limitBytes: number;
    committedBytes: number;
    availableBytes: number;
  };
}

export interface DraftAssetInput {
  key: string;
  originalName: string;
  contentType: string;
  size: number;
}

export interface YouTubeSettings {
  visibility: "public";
  madeForKids: boolean;
}

export interface DraftRequest {
  id: string;
  title: string;
  description: string;
  scheduledAt: string | null;
  timezone: string;
  platforms: Record<Platform, boolean>;
  youtube: YouTubeSettings;
  assets: {
    video: DraftAssetInput;
    thumbnail: DraftAssetInput;
  };
}

export interface StoredJob extends DraftRequest {
  schemaVersion: 2 | 3;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  youtubeVideoId?: string;
  youtubeResult?: {
    videoId: string;
    acceptedAt: string;
    uploadStatus: string;
    privacyStatus: "private";
    publishAt: string;
    thumbnailApplied: boolean;
    mediaDeleted?: boolean;
    warnings?: string[];
  };
}

export interface CreateJobResponse {
  id: string;
  status: "uploading";
  youtube: {
    uploadUrl: string;
    accessToken: string;
  };
}

export interface CompleteYouTubeRequest {
  videoId: string;
}

export interface CompleteYouTubeResponse {
  id: string;
  status: "scheduled";
  videoId: string;
  publishAt: string;
  mediaDeleted: boolean;
  thumbnailApplied: boolean;
  warnings: string[];
}

export interface JobStateUpdateRequest {
  status: "failed" | "cancelled";
  error?: string;
}

export interface AppEvent {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: "upload" | "youtube" | "storage" | "oauth" | "system";
  message: string;
  platform?: Platform;
  jobId?: string;
}

export interface SystemJobSummary {
  id: string;
  platform: Platform;
  status: "uploading" | "processing" | "scheduled" | "failed" | "cancelled";
  fileSizeBytes: number;
  createdAt: string;
  scheduledAt: string | null;
  temporaryMediaDeleted: boolean;
  videoId?: string;
  lastError?: string;
}

export interface SystemStatusResponse {
  generatedAt: string;
  storage: {
    usedBytes: number;
    capBytes: number;
    usedPercent: number;
    temporaryObjectCount: number;
    oldestTemporaryObject: {
      key: string;
      size: number;
      uploadedAt: string;
    } | null;
  };
  connections: Record<Platform, boolean>;
  jobs: SystemJobSummary[];
  recentErrors: AppEvent[];
  events: AppEvent[];
  localWorker: {
    configured: false;
  };
}

export interface YouTubeConnectionStatus {
  connected: boolean;
}

export interface ApiError {
  error: string;
}
