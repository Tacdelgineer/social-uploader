import {
  INSTAGRAM_COVER_MAX_BYTES,
  INSTAGRAM_VIDEO_MAX_BYTES,
  R2_STORAGE_CAP_BYTES,
  THUMBNAIL_MAX_BYTES,
  YOUTUBE_THUMBNAIL_CONTENT_TYPES,
  type EditScheduledPostRequest,
  type Platform,
  type ScheduledPostSummary,
  type StoredJob,
} from "../shared/contracts";
import { getTemporaryStorageMetrics } from "./capacity";
import type { Env } from "./env";
import { recordAppEvent } from "./events";
import { getInstagramCredentials } from "./instagram-oauth";
import {
  cleanupReleasedMedia,
  hasFailedPlatform,
  jobRequiresSource,
  listAllJobs,
  loadJob,
  normalizeOverallStatus,
  putJobWithRetry,
  retryMediaExpiresAt,
} from "./job-store";
import { getYouTubeAccessToken } from "./oauth";
import { getTikTokCredentials } from "./tiktok-oauth";
import { queryTikTokCreatorInfo, validateCreatorSettings } from "./tiktok";
import { isTikTokAppAudited } from "./tiktok-review";
import { validateDraftRequest } from "./validation";
import {
  deleteYouTubeVideo,
  setYouTubeThumbnail,
  updateYouTubeScheduledVideo,
  uploadYouTubeVideoFromR2,
  verifyYouTubeSchedule,
} from "./youtube";

export async function listScheduledPosts(env: Env, now = new Date()): Promise<ScheduledPostSummary[]> {
  const jobs = await listAllJobs(env);
  return jobs
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((job) => summarize(job, now));
}

export async function getScheduledThumbnail(env: Env, jobId: string): Promise<Response> {
  const job = await loadJob(env, jobId);
  if (!job) return new Response("Post not found.", { status: 404 });
  const thumbnail = await env.UPLOADS.get(job.assets.thumbnail.key);
  if (!thumbnail) return new Response("Thumbnail not found.", { status: 404 });
  const headers = new Headers();
  thumbnail.writeHttpMetadata(headers);
  headers.set("cache-control", "private, max-age=60");
  headers.set("content-length", String(thumbnail.size));
  return new Response(thumbnail.body, { headers });
}

export async function replaceScheduledThumbnail(
  request: Request,
  env: Env,
  jobId: string,
): Promise<ScheduledPostSummary> {
  const job = await requireScheduledJob(env, jobId);
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const body = await request.arrayBuffer();
  const size = body.byteLength;
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(contentType) ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > THUMBNAIL_MAX_BYTES
  ) {
    throw new Error("The replacement thumbnail must be JPG, PNG, or WebP and no larger than 10 MB.");
  }
  if (job.platforms.youtube && !(YOUTUBE_THUMBNAIL_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new Error("YouTube replacement thumbnails must be JPG or PNG.");
  }
  if (job.platforms.instagram && (contentType !== "image/jpeg" || size > INSTAGRAM_COVER_MAX_BYTES)) {
    throw new Error("Instagram Reel covers must be JPEG and no larger than 8 MB.");
  }
  const metrics = await getTemporaryStorageMetrics(env.UPLOADS);
  if (metrics.usedBytes + size > R2_STORAGE_CAP_BYTES) {
    throw new Error("This replacement would exceed the 8 GB temporary R2 storage cap.");
  }

  const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
  const key = `scheduled/${job.id}/thumbnail-${crypto.randomUUID()}.${extension}`;
  await env.UPLOADS.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { purpose: "scheduled-thumbnail", originalName: safeFileName(request.headers.get("x-file-name")) },
  });
  const stored = await env.UPLOADS.get(key);
  if (!stored || stored.size !== size) {
    await env.UPLOADS.delete(key);
    throw new Error("The replacement thumbnail did not reach R2 intact.");
  }

  try {
    if (job.platforms.youtube && job.youtubeResult) {
      const token = await getYouTubeAccessToken(env);
      await setYouTubeThumbnail(job.youtubeResult.videoId, stored, contentType, token);
    }
    let updated: StoredJob = {
      ...job,
      schemaVersion: 6,
      mediaDeleted: false,
      assets: {
        ...job.assets,
        thumbnail: {
          key,
          originalName: safeFileName(request.headers.get("x-file-name")),
          contentType,
          size,
        },
      },
      updatedAt: new Date().toISOString(),
      youtubeResult: job.youtubeResult ? { ...job.youtubeResult, thumbnailApplied: true } : undefined,
    };
    await putJobWithRetry(env, updated);
    if (job.assets.thumbnail.key !== key) await env.UPLOADS.delete(job.assets.thumbnail.key);
    if (!job.platforms.instagram && !job.platforms.tiktok) {
      await env.UPLOADS.delete(key);
      updated = { ...updated, mediaDeleted: true, updatedAt: new Date().toISOString() };
      await putJobWithRetry(env, updated);
    }
    await recordAppEvent(env, {
      level: "info",
      category: "upload",
      jobId,
      message: "Scheduled post thumbnail/cover updated.",
    });
    return summarize(updated);
  } catch (error) {
    await env.UPLOADS.delete(key);
    throw error;
  }
}

export async function editScheduledPost(
  env: Env,
  jobId: string,
  input: EditScheduledPostRequest,
  now = new Date(),
): Promise<ScheduledPostSummary> {
  const job = await requireScheduledJob(env, jobId, now);
  const candidate = validateDraftRequest({
    ...job,
    title: input.title,
    description: input.description,
    scheduledAt: input.scheduledAt,
    platforms: input.platforms,
    youtube: input.youtube,
    instagram: input.instagram,
    tiktok: input.tiktok,
  }, now);
  if (!candidate || new Date(input.scheduledAt).getTime() <= now.getTime() + 60_000) {
    throw new Error("Choose a valid publish time at least one minute in the future and supported platform settings.");
  }
  if (!job.platforms.instagram && candidate.platforms.instagram && job.assets.video.size > INSTAGRAM_VIDEO_MAX_BYTES) {
    throw new Error("This source video is too large to add Instagram.");
  }
  const added = selected(candidate).filter((platform) => !job.platforms[platform]);
  if (added.length > 0 && job.mediaDeleted) {
    throw new Error("The source video was already released, so another platform cannot be added to this post.");
  }
  if (candidate.platforms.instagram) await getInstagramCredentials(env);
  if (candidate.platforms.tiktok) {
    const { accessToken } = await getTikTokCredentials(env);
    const creator = await queryTikTokCreatorInfo(accessToken);
    validateCreatorSettings(candidate, creator, isTikTokAppAudited(env));
  }
  const youtubeToken = candidate.platforms.youtube || job.platforms.youtube
    ? await getYouTubeAccessToken(env)
    : undefined;

  let youtubeResult = job.youtubeResult;
  let youtubeVideoId = job.youtubeVideoId;
  if (job.platforms.youtube && !candidate.platforms.youtube && youtubeResult && youtubeToken) {
    await deleteYouTubeVideo(youtubeResult.videoId, youtubeToken);
    youtubeResult = undefined;
    youtubeVideoId = undefined;
  } else if (candidate.platforms.youtube && job.platforms.youtube && youtubeResult && youtubeToken) {
    const accepted = await updateYouTubeScheduledVideo(youtubeResult.videoId, candidate, youtubeToken);
    youtubeResult = {
      ...youtubeResult,
      uploadStatus: accepted.uploadStatus,
      publishAt: accepted.publishAt,
      warnings: accepted.warnings,
    };
  } else if (candidate.platforms.youtube && !job.platforms.youtube && youtubeToken) {
    const [video, thumbnail] = await Promise.all([
      env.UPLOADS.get(job.assets.video.key),
      env.UPLOADS.get(job.assets.thumbnail.key),
    ]);
    if (!video || !thumbnail) throw new Error("The source media is no longer available to add YouTube.");
    const videoId = await uploadYouTubeVideoFromR2(candidate, video, youtubeToken);
    const accepted = await verifyYouTubeSchedule(videoId, candidate, youtubeToken);
    await setYouTubeThumbnail(videoId, thumbnail, job.assets.thumbnail.contentType, youtubeToken);
    youtubeVideoId = videoId;
    youtubeResult = {
      videoId,
      acceptedAt: new Date().toISOString(),
      uploadStatus: accepted.uploadStatus,
      privacyStatus: "private",
      publishAt: accepted.publishAt,
      thumbnailApplied: true,
      mediaDeleted: false,
      warnings: accepted.warnings,
    };
  }

  const platformStatus: StoredJob["platformStatus"] = {};
  for (const platform of selected(candidate)) {
    if (platform === "youtube") platformStatus.youtube = "scheduled";
    else platformStatus[platform] = "pending";
  }
  let updated = normalizeOverallStatus({
    ...job,
    ...candidate,
    schemaVersion: 6,
    title: candidate.title.trim(),
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    platformStatus,
    platformErrors: {},
    youtubeVideoId,
    youtubeResult,
    instagramResult: candidate.platforms.instagram ? job.instagramResult : undefined,
    tiktokResult: candidate.platforms.tiktok ? job.tiktokResult : undefined,
  });
  await putJobWithRetry(env, updated);
  updated = (await cleanupReleasedMedia(env, updated)).job;
  await recordAppEvent(env, {
    level: "info",
    category: "scheduler",
    jobId,
    message: `Scheduled post updated for ${selected(updated).join(", ")}.`,
  });
  return summarize(updated);
}

export async function retryFailedPlatform(
  env: Env,
  jobId: string,
  platform: "instagram" | "tiktok",
  now = new Date(),
): Promise<ScheduledPostSummary> {
  const job = await loadJob(env, jobId);
  if (!job) throw new Error("Post not found.");
  if (!job.platforms[platform] || job.platformStatus?.[platform] !== "failed") {
    throw new Error(`${platform === "tiktok" ? "TikTok" : "Instagram"} is not a failed step on this post.`);
  }

  const expiresAt = retryMediaExpiresAt(job);
  if (job.mediaDeleted || expiresAt.getTime() <= now.getTime()) {
    await expireRetryMedia(env, job, now);
    throw new Error("Source expired — upload again");
  }
  const [video, thumbnail] = await Promise.all([
    env.UPLOADS.head(job.assets.video.key),
    env.UPLOADS.head(job.assets.thumbnail.key),
  ]);
  if (!video || !thumbnail) {
    await expireRetryMedia(env, job, now);
    throw new Error("Source expired — upload again");
  }

  if (platform === "tiktok") {
    const { accessToken } = await getTikTokCredentials(env);
    const creator = await queryTikTokCreatorInfo(accessToken);
    validateCreatorSettings(job, creator, isTikTokAppAudited(env));
  } else {
    await getInstagramCredentials(env);
  }

  const updated = normalizeOverallStatus({
    ...job,
    schemaVersion: 6,
    updatedAt: now.toISOString(),
    lastError: remainingPlatformError(job, platform),
    retryMediaExpiresAt: expiresAt.toISOString(),
    retryRequestedAt: { ...job.retryRequestedAt, [platform]: now.toISOString() },
    schedulerAttempts: { ...job.schedulerAttempts, [platform]: 0 },
    platformStatus: { ...job.platformStatus, [platform]: "pending" },
    platformErrors: { ...job.platformErrors, [platform]: undefined },
    instagramResult: platform === "instagram" ? undefined : job.instagramResult,
    tiktokResult: platform === "tiktok" ? undefined : job.tiktokResult,
  });
  await putJobWithRetry(env, updated);
  await recordAppEvent(env, {
    level: "info",
    category: platform,
    platform,
    jobId,
    message: `${platform === "tiktok" ? "TikTok" : "Instagram"} retry queued; successful platforms were left unchanged.`,
  });
  return summarize(updated, now);
}

export async function cancelScheduledPost(env: Env, jobId: string, now = new Date()): Promise<void> {
  const job = await requireScheduledJob(env, jobId, now);
  if (job.youtubeResult) {
    const token = await getYouTubeAccessToken(env);
    await deleteYouTubeVideo(job.youtubeResult.videoId, token);
  }
  const platformStatus = Object.fromEntries(
    selected(job).map((platform) => [platform, "cancelled"]),
  ) as StoredJob["platformStatus"];
  const cancelled: StoredJob = {
    ...job,
    schemaVersion: 6,
    status: "cancelled",
    platformStatus,
    cancelledAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await putJobWithRetry(env, cancelled);
  await env.UPLOADS.delete([job.assets.video.key, job.assets.thumbnail.key]);
  await putJobWithRetry(env, { ...cancelled, mediaDeleted: true, updatedAt: new Date().toISOString() });
  await recordAppEvent(env, {
    level: "warning",
    category: "scheduler",
    jobId,
    message: "Scheduled post cancelled; provider schedule and temporary media removed.",
  });
}

async function requireScheduledJob(env: Env, jobId: string, now = new Date()): Promise<StoredJob> {
  const job = await loadJob(env, jobId);
  if (!job) throw new Error("Scheduled post not found.");
  if (!isEditableScheduledJob(job, now)) {
    throw new Error("This post is no longer pending and cannot be changed here.");
  }
  return job;
}

function isEditableScheduledJob(job: StoredJob, now: Date): boolean {
  if (!job.scheduledAt || new Date(job.scheduledAt).getTime() <= now.getTime()) return false;
  if (["cancelled", "completed", "failed", "partial"].includes(job.status)) return false;
  if (job.instagramResult || job.tiktokResult) return false;
  return selected(job).some((platform) => (job.platformStatus?.[platform] ?? "pending") === "scheduled" || (job.platformStatus?.[platform] ?? "pending") === "pending");
}

function summarize(job: StoredJob, now = new Date()): ScheduledPostSummary {
  const sourceMediaAvailable = jobRequiresSource(job, now);
  const canEdit = isEditableScheduledJob(job, now);
  return {
    id: job.id,
    title: job.title,
    description: job.description,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    scheduledAt: job.scheduledAt,
    timezone: job.timezone,
    platforms: job.platforms,
    platformStatus: job.platformStatus ?? {},
    platformErrors: job.platformErrors ?? {},
    fileSizeBytes: job.assets.video.size,
    thumbnailUrl: !sourceMediaAvailable && job.youtubeResult
      ? `https://i.ytimg.com/vi/${encodeURIComponent(job.youtubeResult.videoId)}/mqdefault.jpg`
      : sourceMediaAvailable
        ? `/api/scheduled-posts/${encodeURIComponent(job.id)}/thumbnail`
        : "",
    youtube: job.youtube,
    instagram: job.instagram,
    tiktok: job.tiktok,
    canEdit,
    canCancel: canEdit,
    sourceMediaAvailable,
    mediaExpiresAt: hasFailedPlatform(job) ? retryMediaExpiresAt(job).toISOString() : undefined,
  };
}

async function expireRetryMedia(env: Env, job: StoredJob, now: Date): Promise<void> {
  await env.UPLOADS.delete([job.assets.video.key, job.assets.thumbnail.key]);
  await putJobWithRetry(env, {
    ...job,
    schemaVersion: 6,
    mediaDeleted: true,
    retryMediaExpiresAt: job.retryMediaExpiresAt ?? retryMediaExpiresAt(job).toISOString(),
    updatedAt: now.toISOString(),
  });
}

function remainingPlatformError(job: StoredJob, retried: Platform): string | undefined {
  return selected(job)
    .filter((platform) => platform !== retried && job.platformStatus?.[platform] === "failed")
    .map((platform) => job.platformErrors?.[platform])
    .find((message): message is string => Boolean(message));
}

function selected(job: Pick<StoredJob, "platforms">): Platform[] {
  return (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
}

function safeFileName(value: string | null): string {
  return (value ?? "thumbnail").replace(/[\r\n]/gu, "").slice(0, 255) || "thumbnail";
}
