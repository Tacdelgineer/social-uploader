import {
  INSTAGRAM_COVER_MAX_BYTES,
  INSTAGRAM_VIDEO_MAX_BYTES,
  THUMBNAIL_CONTENT_TYPES,
  THUMBNAIL_MAX_BYTES,
  VIDEO_CONTENT_TYPES,
  VIDEO_MAX_BYTES,
  YOUTUBE_THUMBNAIL_CONTENT_TYPES,
  type AssetKind,
  type DraftRequest,
  type PresignRequest,
  type UploadFileRequest,
} from "../shared/contracts";

const TIKTOK_PRIVACY_OPTIONS = new Set([
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_KEY_PATTERN = /^(?:uploads|staging|scheduled)\/([0-9a-f-]{36})\/(video\.mp4|thumbnail(?:-[0-9a-f-]{36})?\.(jpg|png|webp))$/i;
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
  const { jobId, retention, files } = value;
  if (typeof jobId !== "string" || !UUID_PATTERN.test(jobId)) return null;
  if (retention !== "staging" && retention !== "scheduled") return null;
  if (!Array.isArray(files) || files.length !== 2) return null;
  const validatedFiles = files.map(validateUploadFile);
  if (validatedFiles.some((file) => file === null)) return null;
  const safeFiles = validatedFiles as UploadFileRequest[];
  const kinds = new Set(safeFiles.map((file) => file.kind));
  if (!kinds.has("video") || !kinds.has("thumbnail")) return null;

  return { jobId, retention, files: safeFiles };
}

function validateUploadFile(value: unknown): UploadFileRequest | null {
  if (!isRecord(value)) return null;
  const { kind, fileName, contentType, size } = value;
  if (kind !== "video" && kind !== "thumbnail") return null;
  if (typeof fileName !== "string" || fileName.length < 1 || fileName.length > 255) return null;
  if (typeof contentType !== "string" || extensionFor(kind, contentType) === null) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;

  const allowedTypes = kind === "video" ? VIDEO_CONTENT_TYPES : THUMBNAIL_CONTENT_TYPES;
  const maxBytes = kind === "video" ? VIDEO_MAX_BYTES : THUMBNAIL_MAX_BYTES;
  if (!(allowedTypes as readonly string[]).includes(contentType) || size > maxBytes) return null;

  return { kind, fileName, contentType, size };
}

export function validateDraftRequest(value: unknown, now = new Date()): DraftRequest | null {
  if (!isRecord(value)) return null;
  const {
    id,
    title,
    description,
    scheduledAt,
    timezone,
    videoDurationSeconds,
    platforms,
    youtube,
    instagram,
    tiktok,
    assets,
  } = value;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) return null;
  if (typeof title !== "string" || title.trim().length < 1 || title.length > 100) return null;
  if (typeof description !== "string" || description.length > 2200) return null;
  if (typeof timezone !== "string" || !TIMEZONE_PATTERN.test(timezone)) return null;
  if (
    typeof videoDurationSeconds !== "number" ||
    !Number.isFinite(videoDurationSeconds) ||
    videoDurationSeconds <= 0 ||
    videoDurationSeconds > 10 * 60 * 60
  ) {
    return null;
  }
  if (!isRecord(platforms) || !isPlatformRecord(platforms)) return null;
  if (platforms.youtube) {
    if (
      typeof scheduledAt !== "string" ||
      !isValidIsoDate(scheduledAt) ||
      new Date(scheduledAt).getTime() <= now.getTime() + 60_000
    ) {
      return null;
    }
  } else if (scheduledAt !== null) {
    if (typeof scheduledAt !== "string" || !isValidIsoDate(scheduledAt)) return null;
  }
  if (!isRecord(youtube) || youtube.visibility !== "public" || typeof youtube.madeForKids !== "boolean") {
    return null;
  }
  if (!isRecord(instagram) || typeof instagram.shareToFeed !== "boolean") return null;
  if (
    !isRecord(tiktok) ||
    typeof tiktok.privacy !== "string" ||
    !TIKTOK_PRIVACY_OPTIONS.has(tiktok.privacy) ||
    typeof tiktok.allowComments !== "boolean" ||
    typeof tiktok.allowDuet !== "boolean" ||
    typeof tiktok.allowStitch !== "boolean" ||
    typeof tiktok.consentConfirmed !== "boolean" ||
    (platforms.tiktok && !tiktok.consentConfirmed) ||
    (tiktok.promoteOwnBrand !== undefined && typeof tiktok.promoteOwnBrand !== "boolean") ||
    (tiktok.paidPartnership !== undefined && typeof tiktok.paidPartnership !== "boolean") ||
    typeof tiktok.coverTimestampMs !== "number" ||
    !Number.isSafeInteger(tiktok.coverTimestampMs) ||
    tiktok.coverTimestampMs < 0 ||
    tiktok.coverTimestampMs >= Math.ceil(videoDurationSeconds * 1000)
  ) {
    return null;
  }
  if (!isRecord(assets) || !isAssetInput(assets.video, id, "video") || !isAssetInput(assets.thumbnail, id, "thumbnail")) {
    return null;
  }
  if (!isRecord(assets.video) || !isRecord(assets.thumbnail)) return null;
  if (platforms.youtube) {
    if (
      typeof assets.thumbnail.contentType !== "string" ||
      !(YOUTUBE_THUMBNAIL_CONTENT_TYPES as readonly string[]).includes(assets.thumbnail.contentType)
    ) {
      return null;
    }
  }
  if (platforms.instagram) {
    if (
      typeof assets.video.size !== "number" ||
      typeof assets.thumbnail.size !== "number" ||
      assets.video.size > INSTAGRAM_VIDEO_MAX_BYTES ||
      assets.thumbnail.contentType !== "image/jpeg" ||
      assets.thumbnail.size > INSTAGRAM_COVER_MAX_BYTES ||
      videoDurationSeconds < 3 ||
      videoDurationSeconds > 15 * 60
    ) {
      return null;
    }
  }

  return value as unknown as DraftRequest;
}

function isValidIsoDate(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isPlatformRecord(value: Record<string, unknown>): boolean {
  if (
    typeof value.youtube !== "boolean" ||
    typeof value.instagram !== "boolean" ||
    typeof value.tiktok !== "boolean"
  ) {
    return false;
  }
  return value.youtube || value.instagram || value.tiktok;
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
