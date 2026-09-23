export const VIDEO_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const THUMBNAIL_MAX_BYTES = 10 * 1024 * 1024;

export const VIDEO_CONTENT_TYPES = ["video/mp4"] as const;
export const THUMBNAIL_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AssetKind = "video" | "thumbnail";
export type Platform = "youtube" | "instagram" | "tiktok";

export interface PresignRequest {
  jobId: string;
  kind: AssetKind;
  fileName: string;
  contentType: string;
  size: number;
}

export interface PresignResponse {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export interface DraftAssetInput {
  key: string;
  originalName: string;
  contentType: string;
  size: number;
}

export interface DraftRequest {
  id: string;
  title: string;
  description: string;
  scheduledAt: string | null;
  timezone: string;
  platforms: Record<Platform, boolean>;
  assets: {
    video: DraftAssetInput;
    thumbnail: DraftAssetInput;
  };
}

export interface StoredDraft extends DraftRequest {
  schemaVersion: 1;
  status: "draft";
  createdAt: string;
  updatedAt: string;
}

export interface ApiError {
  error: string;
}

