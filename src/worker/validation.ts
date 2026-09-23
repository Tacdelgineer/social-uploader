import {
  THUMBNAIL_CONTENT_TYPES,
  THUMBNAIL_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  type AssetKind,
  type DraftRequest,
  type PresignRequest,
} from "../shared/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_KEY_PATTERN = /^uploads\/([0-9a-f-]{36})\/(video\.mp4|thumbnail\.(jpg|png|webp))$/i;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,100}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extensionFor(kind: AssetKind, contentType: string): string | null {
  if (kind === "video" && contentType === "video/mp4") return "mp4";
  if (kind === "thumbnail" && contentType === "image/jpeg") return "jpg";
  if (kind === "thumbnail" && contentType === "image/png") return "png";
  if (kind === "thumbnail" && contentType === "image/webp") return "webp";
  return null;
}

export function validatePresignRequest(value: unknown): PresignRequest | null {
  if (!isRecord(value)) return null;
  const { jobId, kind, fileName, contentType, size } = value;
  if (typeof jobId !== "string" || !UUID_PATTERN.test(jobId)) return null;
  if (kind !== "video" && kind !== "thumbnail") return null;
  if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 255) return null;
  if (typeof contentType !== "string" || extensionFor(kind, contentType) === null) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;

  const allowedTypes = kind === "video" ? VIDEO_CONTENT_TYPES : THUMBNAIL_CONTENT_TYPES;
  const maxBytes = kind === "video" ? VIDEO_MAX_BYTES : THUMBNAIL_MAX_BYTES;
  if (!(allowedTypes as readonly string[]).includes(contentType) || size > maxBytes) return null;

  return { jobId, kind, fileName, contentType, size };
}

export function validateDraftRequest(value: unknown): DraftRequest | null {
  if (!isRecord(value)) return null;
  const { id, title, description, scheduledAt, timezone, platforms, assets } = value;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 200) return null;
  if (typeof description !== "string" || description.length > 2200) return null;
  if (scheduledAt !== null && (typeof scheduledAt !== "string" || !isValidIsoDate(scheduledAt))) return null;
  if (typeof timezone !== "string" || !TIMEZONE_PATTERN.test(timezone)) return null;
  if (!isRecord(platforms) || !isPlatformRecord(platforms)) return null;
  if (!isRecord(assets) || !isAssetInput(assets.video, id, "video") || !isAssetInput(assets.thumbnail, id, "thumbnail")) {
    return null;
  }

  return value as unknown as DraftRequest;
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPlatformRecord(value: Record<string, unknown>): boolean {
  const keys = ["youtube", "instagram", "tiktok"];
  return keys.every((key) => typeof value[key] === "boolean") && keys.some((key) => value[key] === true);
}

function isAssetInput(value: unknown, jobId: string, kind: AssetKind): boolean {
  if (!isRecord(value)) return false;
  const { key, originalName, contentType, size } = value;
  if (typeof key !== "string" || typeof originalName !== "string" || originalName.length > 255) return false;
  if (typeof contentType !== "string" || typeof size !== "number" || !Number.isSafeInteger(size)) return false;
  const match = ASSET_KEY_PATTERN.exec(key);
  if (!match || match[1]?.toLowerCase() !== jobId.toLowerCase()) return false;
  if (kind === "video" && match[2]?.toLowerCase() !== "video.mp4") return false;
  if (kind === "thumbnail" && !match[2]?.toLowerCase().startsWith("thumbnail.")) return false;
  return extensionFor(kind, contentType) !== null && size > 0;
}

