export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;
export const R2_STORAGE_CAP_BYTES = 8_000_000_000;
export const INSTAGRAM_VIDEO_MAX_BYTES = 300 * 1024 * 1024;
export const INSTAGRAM_COVER_MAX_BYTES = 8 * 1024 * 1024;

export const VIDEO_CONTENT_TYPES = ["video/mp4"] as const;
export const THUMBNAIL_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const YOUTUBE_THUMBNAIL_CONTENT_TYPES = ["image/jpeg", "image/png"] as const;

export type AssetKind = "video" | "thumbnail";
export type Platform = "youtube" | "instagram" | "tiktok";
export type JobStatus =
  | "uploading"
  | "processing"
  | "scheduled"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "uploading_to_youtube"
  | "scheduled_on_youtube";
export type PlatformJobStatus =
  | "pending"
  | "uploading"
  | "processing"
  | "scheduled"
  | "published"
  | "cancelled"
  | "failed";

export interface UploadFileRequest {
  kind: AssetKind;
  fileName: string;
  contentType: string;
  size: number;
}

export interface PresignRequest {
  jobId: string;
  retention: "staging" | "scheduled";
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

export interface InstagramSettings {
  shareToFeed: boolean;
}

export interface TikTokSettings {
  privacy: "SELF_ONLY";
  allowComments: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  coverTimestampMs: number;
  consentConfirmed: boolean;
}

export interface DraftRequest {
  id: string;
  title: string;
  description: string;
  scheduledAt: string | null;
  timezone: string;
  videoDurationSeconds: number;
  platforms: Record<Platform, boolean>;
  youtube: YouTubeSettings;
  instagram: InstagramSettings;
  tiktok: TikTokSettings;
  assets: {
    video: DraftAssetInput;
    thumbnail: DraftAssetInput;
  };
}

export interface StoredJob extends DraftRequest {
  schemaVersion: 2 | 3 | 4 | 5 | 6;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  mediaDeleted?: boolean;
  platformStatus?: Partial<Record<Platform, PlatformJobStatus>>;
  platformErrors?: Partial<Record<Platform, string>>;
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
  instagramResult?: {
    containerId: string;
    statusCode: string;
    mediaTransferred: boolean;
    mediaId?: string;
    acceptedAt?: string;
    warnings?: string[];
  };
  tiktokResult?: {
    publishId: string;
    status: string;
    uploadCompleted: boolean;
    uploadedBytes: number;
    postIds: string[];
    acceptedAt?: string;
    warnings?: string[];
    encryptedUploadUrl?: string;
    chunkSize?: number;
    totalChunkCount?: number;
  };
  schedulerAttempts?: Partial<Record<Platform, number>>;
  retryRequestedAt?: Partial<Record<Platform, string>>;
  retryMediaExpiresAt?: string;
  lastSchedulerAttemptAt?: string;
  cancelledAt?: string;
}

export interface CreateJobResponse {
  id: string;
  status: "uploading";
  youtube?: {
    uploadUrl: string;
    accessToken: string;
  };
}

export interface ScheduledPostSummary {
  id: string;
  title: string;
  description: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  timezone: string;
  platforms: Record<Platform, boolean>;
  platformStatus: Partial<Record<Platform, PlatformJobStatus>>;
  platformErrors: Partial<Record<Platform, string>>;
  fileSizeBytes: number;
  thumbnailUrl: string;
  youtube: YouTubeSettings;
  instagram: InstagramSettings;
  tiktok: TikTokSettings;
  canEdit: boolean;
  canCancel: boolean;
  sourceMediaAvailable: boolean;
  mediaExpiresAt?: string;
}

export interface ScheduledPostsResponse {
  posts: ScheduledPostSummary[];
}

export interface EditScheduledPostRequest {
  title: string;
  description: string;
  scheduledAt: string;
  platforms: Record<Platform, boolean>;
  youtube: YouTubeSettings;
  instagram: InstagramSettings;
  tiktok: TikTokSettings;
}

export interface CompleteYouTubeRequest {
  videoId: string;
}

export interface CompleteYouTubeResponse {
  id: string;
  status: "scheduled" | "completed";
  videoId: string;
  publishAt: string;
  mediaDeleted: boolean;
  thumbnailApplied: boolean;
  warnings: string[];
}

export interface PlatformConnectionStatus {
  connected: boolean;
  displayName?: string;
  requiresReconnect?: boolean;
  message?: string;
}

export interface InstagramPublishResponse {
  status: "processing" | "published";
  containerId: string;
  statusCode: string;
  mediaId?: string;
  mediaDeleted: boolean;
  warnings: string[];
}

export interface TikTokCreatorInfo {
  username: string;
  nickname: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSeconds: number;
  isPrivateAccount: boolean;
}

export interface TikTokStartResponse {
  publishId: string;
  uploadUrl: string;
  chunkSize: number;
  totalChunkCount: number;
  creatorInfo: TikTokCreatorInfo;
}

export interface TikTokPublishStatusResponse {
  status: string;
  publishComplete: boolean;
  uploadCompleted: boolean;
  uploadedBytes: number;
  postIds: string[];
  mediaDeleted: boolean;
  failReason?: string;
  warnings: string[];
}

export interface JobStateUpdateRequest {
  status: "failed" | "cancelled";
  error?: string;
  platform?: Platform;
}

export interface AppEvent {
  id: string;
  timestamp: string;
  level: "info" | "warning" | "error";
  category: "upload" | "youtube" | "instagram" | "tiktok" | "storage" | "cleanup" | "scheduler" | "oauth" | "system";
  message: string;
  platform?: Platform;
  jobId?: string;
}

export interface SystemJobSummary {
  id: string;
  title: string;
  platform: Platform;
  platforms?: Platform[];
  status: "uploading" | "processing" | "scheduled" | "completed" | "partial" | "failed" | "cancelled";
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
  scheduling: {
    pendingCount: number;
    failedCount: number;
    nextPublishAt: string | null;
    pendingMediaBytes: number;
    pendingMediaObjectCount: number;
    orphanStagingBytes: number;
    orphanStagingObjectCount: number;
    recentRuns: SchedulerRun[];
  };
  platformResults: Record<Platform, { succeeded: number; failed: number; pending: number }>;
  jobs: SystemJobSummary[];
  recentErrors: AppEvent[];
  events: AppEvent[];
  localWorker: {
    configured: false;
  };
}

export interface SchedulerRun {
  startedAt: string;
  finishedAt: string;
  dueJobs: number;
  processedPlatforms: number;
  succeeded: number;
  failed: number;
  deletedObjects: number;
}

export interface YouTubeConnectionStatus {
  connected: boolean;
}

export interface ApiError {
  error: string;
}
