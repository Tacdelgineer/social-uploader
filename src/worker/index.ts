import { AwsClient } from "aws4fetch";
import { R2_STORAGE_CAP_BYTES } from "../shared/contracts";
import type {
  ApiError,
  AssetKind,
  CompleteYouTubeRequest,
  CompleteYouTubeResponse,
  CreateJobResponse,
  DraftRequest,
  EditScheduledPostRequest,
  InstagramPublishResponse,
  JobStateUpdateRequest,
  Platform,
  PresignedUpload,
  PresignResponse,
  StoredJob,
  TikTokPublishStatusResponse,
  TikTokStartResponse,
  UploadFileRequest,
} from "../shared/contracts";
import {
  CapacityExceededError,
  DuplicateJobError,
  reserveUploadCapacity,
} from "./capacity";
import type { Env } from "./env";
import { recordAppEvent } from "./events";
import {
  beginInstagramOAuth,
  disconnectInstagram,
  finishInstagramOAuth,
  getInstagramCredentials,
  instagramConnectionStatus,
} from "./instagram-oauth";
import {
  createInstagramReelContainer,
  getInstagramContainerStatus,
  publishInstagramReel,
  verifyInstagramReel,
} from "./instagram";
import {
  cleanupReleasedMedia,
  FAILED_MEDIA_RETENTION_MS,
  jobKey,
  loadJob,
  markPlatformFailed,
  normalizeOverallStatus,
  putJobWithRetry,
  setPlatformStatus,
} from "./job-store";
import {
  beginYouTubeOAuth,
  disconnectYouTube,
  finishYouTubeOAuth,
  getYouTubeAccessToken,
  youtubeConnectionStatus,
} from "./oauth";
import { getSystemStatus } from "./system-status";
import {
  cancelScheduledPost,
  editScheduledPost,
  getScheduledThumbnail,
  listScheduledPosts,
  replaceScheduledThumbnail,
  retryFailedPlatform,
} from "./scheduled-posts";
import { runScheduler } from "./scheduler";
import {
  beginTikTokOAuth,
  disconnectTikTok,
  finishTikTokOAuth,
  getTikTokCredentials,
  tiktokConnectionStatus,
} from "./tiktok-oauth";
import {
  fetchTikTokPostStatus,
  initializeTikTokDirectPost,
  queryTikTokCreatorInfo,
  validateCreatorSettings,
} from "./tiktok";
import { getTikTokReviewStatus, isTikTokAppAudited } from "./tiktok-review";
import { extensionFor, validateDraftRequest, validatePresignRequest } from "./validation";
import { setYouTubeThumbnail, startYouTubeUpload, verifyYouTubeSchedule } from "./youtube";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/u;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      const message = errorMessage(error);
      if (new URL(request.url).pathname.startsWith("/api/")) {
        await recordAppEvent(env, { level: "error", category: "system", message });
      }
      return json({ error: message } satisfies ApiError, 500);
    }
  },
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runScheduler(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      service: "social-uploader",
      milestone: 4,
      storage: "temporary-r2-and-kv-metadata",
      storageCapBytes: R2_STORAGE_CAP_BYTES,
      cleanupFallbackDays: 7,
    });
  }
  if (url.pathname === "/api/system/status" && request.method === "GET") {
    return json(await getSystemStatus(env));
  }
  if (url.pathname === "/api/scheduled-posts" && request.method === "GET") {
    return json({ posts: await listScheduledPosts(env) });
  }
  const scheduledThumbnailMatch = /^\/api\/scheduled-posts\/([^/]+)\/thumbnail$/u.exec(url.pathname);
  if (scheduledThumbnailMatch && request.method === "GET") {
    return getScheduledThumbnail(env, scheduledThumbnailMatch[1] ?? "");
  }
  if (url.pathname === "/api/oauth/youtube/start" && request.method === "GET") {
    return beginYouTubeOAuth(env);
  }
  if (url.pathname === "/api/oauth/youtube/callback" && request.method === "GET") {
    return finishYouTubeOAuth(request, env);
  }
  if (url.pathname === "/api/oauth/youtube/status" && request.method === "GET") {
    return json(await youtubeConnectionStatus(env));
  }
  if (url.pathname === "/api/oauth/youtube/disconnect" && request.method === "POST") {
    await disconnectYouTube(env);
    await recordAppEvent(env, {
      level: "info",
      category: "oauth",
      platform: "youtube",
      message: "YouTube disconnected.",
    });
    return json({ disconnected: true });
  }
  if (url.pathname === "/api/oauth/instagram/start" && request.method === "GET") {
    return beginInstagramOAuth(env);
  }
  if (url.pathname === "/api/oauth/instagram/callback" && request.method === "GET") {
    return finishInstagramOAuth(request, env);
  }
  if (url.pathname === "/api/oauth/instagram/status" && request.method === "GET") {
    return json(await instagramConnectionStatus(env));
  }
  if (url.pathname === "/api/oauth/instagram/disconnect" && request.method === "POST") {
    await disconnectInstagram(env);
    await recordAppEvent(env, {
      level: "info",
      category: "oauth",
      platform: "instagram",
      message: "Instagram disconnected.",
    });
    return json({ disconnected: true });
  }
  if (url.pathname === "/api/oauth/tiktok/start" && request.method === "GET") {
    return beginTikTokOAuth(env);
  }
  if (url.pathname === "/api/oauth/tiktok/callback" && request.method === "GET") {
    return finishTikTokOAuth(request, env);
  }
  if (url.pathname === "/api/oauth/tiktok/status" && request.method === "GET") {
    return json(await tiktokConnectionStatus(env));
  }
  if (url.pathname === "/api/oauth/tiktok/disconnect" && request.method === "POST") {
    await disconnectTikTok(env);
    await recordAppEvent(env, {
      level: "info",
      category: "oauth",
      platform: "tiktok",
      message: "TikTok disconnected.",
    });
    return json({ disconnected: true });
  }
  if (url.pathname === "/api/tiktok/creator-info" && request.method === "GET") {
    const { accessToken } = await getTikTokCredentials(env);
    return json(await queryTikTokCreatorInfo(accessToken));
  }
  if (url.pathname === "/api/tiktok/review-status" && request.method === "GET") {
    return json(await getTikTokReviewStatus(env));
  }
  if (url.pathname === "/api/uploads/presign" && request.method === "POST") {
    return createPresignedUpload(request, env);
  }
  if (url.pathname === "/api/jobs" && request.method === "POST") {
    return createJob(request, env);
  }

  const jobMatch = /^\/api\/jobs\/([^/]+)$/u.exec(url.pathname);
  if (jobMatch && request.method === "GET") return getJob(env, jobMatch[1] ?? "");
  if (jobMatch && request.method === "POST") {
    return updateJobState(request, env, jobMatch[1] ?? "");
  }
  if (jobMatch && request.method === "PATCH") {
    return updateScheduledJob(request, env, jobMatch[1] ?? "");
  }
  if (jobMatch && request.method === "DELETE") {
    return deleteScheduledJob(env, jobMatch[1] ?? "");
  }

  const thumbnailReplaceMatch = /^\/api\/jobs\/([^/]+)\/thumbnail$/u.exec(url.pathname);
  if (thumbnailReplaceMatch && request.method === "PUT") {
    return replaceScheduledJobThumbnail(request, env, thumbnailReplaceMatch[1] ?? "");
  }

  const retryMatch = /^\/api\/jobs\/([^/]+)\/retry\/(instagram|tiktok)$/u.exec(url.pathname);
  if (retryMatch && request.method === "POST") {
    if (!UUID_PATTERN.test(retryMatch[1] ?? "")) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
    try {
      return json(await retryFailedPlatform(
        env,
        retryMatch[1]!,
        retryMatch[2] as "instagram" | "tiktok",
      ));
    } catch (error) {
      return json({ error: errorMessage(error) } satisfies ApiError, 409);
    }
  }

  const completionMatch = /^\/api\/jobs\/([^/]+)\/youtube\/complete$/u.exec(url.pathname);
  if (completionMatch && request.method === "POST") {
    return completeYouTubeUpload(request, env, completionMatch[1] ?? "");
  }

  const instagramStartMatch = /^\/api\/jobs\/([^/]+)\/instagram\/start$/u.exec(url.pathname);
  if (instagramStartMatch && request.method === "POST") {
    return startInstagramPublish(env, instagramStartMatch[1] ?? "");
  }
  const instagramStatusMatch = /^\/api\/jobs\/([^/]+)\/instagram\/status$/u.exec(url.pathname);
  if (instagramStatusMatch && request.method === "POST") {
    return checkInstagramPublish(env, instagramStatusMatch[1] ?? "");
  }
  const tiktokStartMatch = /^\/api\/jobs\/([^/]+)\/tiktok\/start$/u.exec(url.pathname);
  if (tiktokStartMatch && request.method === "POST") {
    return startTikTokPublish(env, tiktokStartMatch[1] ?? "");
  }
  const tiktokUploadedMatch = /^\/api\/jobs\/([^/]+)\/tiktok\/uploaded$/u.exec(url.pathname);
  if (tiktokUploadedMatch && request.method === "POST") {
    return confirmTikTokUpload(env, tiktokUploadedMatch[1] ?? "");
  }
  const tiktokStatusMatch = /^\/api\/jobs\/([^/]+)\/tiktok\/status$/u.exec(url.pathname);
  if (tiktokStatusMatch && request.method === "POST") {
    return checkTikTokPublish(env, tiktokStatusMatch[1] ?? "");
  }

  if (url.pathname.startsWith("/api/")) {
    return json({ error: "Not found." } satisfies ApiError, 404);
  }
  return env.ASSETS.fetch(request);
}

async function createPresignedUpload(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = validatePresignRequest(body);
  if (!input) return json({ error: "Invalid upload request." } satisfies ApiError, 400);

  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return json({ error: "R2 upload signing is not configured." } satisfies ApiError, 503);
  }

  const filesByKind = Object.fromEntries(
    input.files.map((file) => [file.kind, file]),
  ) as Record<AssetKind, UploadFileRequest>;
  const objectKeys = input.files.map((file) => objectKeyFor(input.jobId, input.retention, file));
  let capacity;
  try {
    capacity = await reserveUploadCapacity(env.UPLOADS, input, objectKeys);
  } catch (error) {
    if (error instanceof CapacityExceededError) {
      return json({ error: error.message } satisfies ApiError, 507);
    }
    if (error instanceof DuplicateJobError) {
      return json({ error: error.message } satisfies ApiError, 409);
    }
    throw error;
  }

  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });

  const [video, thumbnail] = await Promise.all([
    signUpload(client, endpoint, env.R2_BUCKET_NAME, input.jobId, input.retention, filesByKind.video, capacity.expiresIn),
    signUpload(
      client,
      endpoint,
      env.R2_BUCKET_NAME,
      input.jobId,
      input.retention,
      filesByKind.thumbnail,
      capacity.expiresIn,
    ),
  ]);

  return json({
    uploads: { video, thumbnail },
    capacity: {
      limitBytes: capacity.limitBytes,
      committedBytes: capacity.committedBytes,
      availableBytes: capacity.availableBytes,
    },
  } satisfies PresignResponse);
}

async function signUpload(
  client: AwsClient,
  endpoint: string,
  bucketName: string,
  jobId: string,
  retention: "staging" | "scheduled",
  file: UploadFileRequest,
  expiresIn: number,
): Promise<PresignedUpload> {
  const objectKey = objectKeyFor(jobId, retention, file);
  const objectUrl = `${endpoint}/${bucketName}/${objectKey}?X-Amz-Expires=${expiresIn}`;
  const signed = await client.sign(
    new Request(objectUrl, {
      method: "PUT",
      headers: {
        "content-length": String(file.size),
        "content-type": file.contentType,
      },
    }),
    { aws: { signQuery: true, allHeaders: true } },
  );
  return { uploadUrl: signed.url, objectKey, expiresIn };
}

function objectKeyFor(
  jobId: string,
  retention: "staging" | "scheduled",
  file: UploadFileRequest,
): string {
  return `${retention}/${jobId}/${file.kind}.${extensionFor(file.kind, file.contentType)}`;
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = validateDraftRequest(body);
  if (!input) {
    return json(
      { error: "Invalid job or platform-specific media/settings." } satisfies ApiError,
      400,
    );
  }

  const assetError = await verifyAssets(input, env.UPLOADS);
  if (assetError) return json({ error: assetError } satisfies ApiError, 409);
  if (await env.METADATA.get(jobKey(input.id))) {
    return json({ error: "A job with this ID already exists." } satisfies ApiError, 409);
  }

  const accessToken = input.platforms.youtube ? await getYouTubeAccessToken(env) : undefined;
  if (input.platforms.instagram) await getInstagramCredentials(env);
  if (input.platforms.tiktok) {
    const { accessToken: tiktokAccessToken } = await getTikTokCredentials(env);
    const creator = await queryTikTokCreatorInfo(tiktokAccessToken);
    try {
      validateCreatorSettings(input, creator, isTikTokAppAudited(env));
    } catch (error) {
      return json(
        { error: errorMessage(error) } satisfies ApiError,
        409,
      );
    }
  }
  const uploadUrl = accessToken ? await startYouTubeUpload(input, accessToken) : undefined;
  const now = new Date().toISOString();
  const platformStatus = Object.fromEntries(
    (Object.entries(input.platforms) as Array<[Platform, boolean]>)
      .filter(([, enabled]) => enabled)
      .map(([platform]) => [platform, platform === "youtube" ? "uploading" : "pending"]),
  ) as StoredJob["platformStatus"];
  const job: StoredJob = normalizeOverallStatus({
    ...input,
    title: input.title.trim(),
    schemaVersion: 6,
    status: "uploading",
    platformStatus,
    createdAt: now,
    updatedAt: now,
  });
  await putJobWithRetry(env, job);
  await recordAppEvent(env, {
    level: "info",
    category: "upload",
    jobId: job.id,
    message: `Job created for ${enabledPlatforms(job).join(", ")}.`,
  });

  const response: CreateJobResponse = {
    id: job.id,
    status: "uploading",
  };
  if (uploadUrl && accessToken) response.youtube = { uploadUrl, accessToken };
  return json(response, 201);
}

async function getJob(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const job = await loadJob(env, jobId);
  return job ? json(job) : json({ error: "Job not found." } satisfies ApiError, 404);
}

async function updateScheduledJob(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as EditScheduledPostRequest | null;
  if (!body) return json({ error: "Invalid scheduled post update." } satisfies ApiError, 400);
  try {
    return json(await editScheduledPost(env, jobId, body));
  } catch (error) {
    return json({ error: errorMessage(error) } satisfies ApiError, 409);
  }
}

async function deleteScheduledJob(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  try {
    await cancelScheduledPost(env, jobId);
    return json({ cancelled: true });
  } catch (error) {
    return json({ error: errorMessage(error) } satisfies ApiError, 409);
  }
}

async function replaceScheduledJobThumbnail(
  request: Request,
  env: Env,
  jobId: string,
): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  try {
    return json(await replaceScheduledThumbnail(request, env, jobId));
  } catch (error) {
    return json({ error: errorMessage(error) } satisfies ApiError, 409);
  }
}

async function updateJobState(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as Partial<JobStateUpdateRequest> | null;
  if (!body || !["failed", "cancelled"].includes(body.status ?? "")) {
    return json({ error: "Invalid job state." } satisfies ApiError, 400);
  }
  const job = await loadJob(env, jobId);
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (body.platform && !["youtube", "instagram", "tiktok"].includes(body.platform)) {
    return json({ error: "Invalid platform." } satisfies ApiError, 400);
  }
  if (body.status === "failed" && body.platform) {
    const message = body.error?.slice(0, 500) || `${body.platform} failed.`;
    const failed = await markPlatformFailed(env, jobId, body.platform, message);
    await recordAppEvent(env, {
      level: "error",
      category: body.platform,
      platform: body.platform,
      jobId,
      message,
    });
    return json(failed);
  }

  const status = body.status as JobStateUpdateRequest["status"];
  const now = new Date();
  const platformStatus = Object.fromEntries(
    enabledPlatforms(job).map((platform) => {
      const current = job.platformStatus?.[platform] ?? "pending";
      if (status === "cancelled") return [platform, "cancelled"];
      return [platform, ["scheduled", "published"].includes(current) ? current : "failed"];
    }),
  ) as StoredJob["platformStatus"];
  let updated: StoredJob = {
    ...job,
    schemaVersion: 6,
    status,
    platformStatus,
    retryMediaExpiresAt: status === "failed"
      ? job.retryMediaExpiresAt ?? new Date(now.getTime() + FAILED_MEDIA_RETENTION_MS).toISOString()
      : job.retryMediaExpiresAt,
    updatedAt: now.toISOString(),
    lastError: body.error?.slice(0, 500),
  };
  await putJobWithRetry(env, updated);
  const cleanup = status === "cancelled" ? await cleanupReleasedMedia(env, updated) : undefined;
  if (cleanup) updated = cleanup.job;
  await recordAppEvent(env, {
    level: status === "failed" ? "error" : "warning",
    category: "upload",
    jobId,
    message: status === "failed"
      ? updated.lastError ?? "Upload failed."
      : `Upload cancelled by user; temporary media removed.${cleanup?.warning ? ` ${cleanup.warning}` : ""}`,
  });
  return json(updated);
}

async function completeYouTubeUpload(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as Partial<CompleteYouTubeRequest> | null;
  if (!body || typeof body.videoId !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(body.videoId)) {
    return json({ error: "Invalid YouTube video ID." } satisfies ApiError, 400);
  }

  const job = await loadJob(env, jobId);
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (!job.platforms.youtube) return json({ error: "YouTube is not selected for this job." } satisfies ApiError, 409);
  if (job.youtubeResult) {
    return json(completionResponse(job));
  }
  if (job.youtubeVideoId && job.youtubeVideoId !== body.videoId) {
    return json({ error: "This job is already associated with a different YouTube video." } satisfies ApiError, 409);
  }

  const processing = setPlatformStatus({
    ...job,
    youtubeVideoId: body.videoId,
  }, "youtube", "processing");
  await putJobWithRetry(env, processing);
  await recordAppEvent(env, {
    level: "info",
    category: "youtube",
    platform: "youtube",
    jobId,
    message: `YouTube received video ${body.videoId}; verifying its native schedule.`,
  });

  let accessToken: string;
  let accepted;
  try {
    accessToken = await getYouTubeAccessToken(env);
    accepted = await verifyYouTubeSchedule(body.videoId, processing, accessToken);
  } catch (error) {
    const message = errorMessage(error);
    await markPlatformFailed(env, jobId, "youtube", message);
    await recordAppEvent(env, {
      level: "error",
      category: "youtube",
      platform: "youtube",
      jobId,
      message,
    });
    return json({ error: `${message} Temporary source media was preserved.` } satisfies ApiError, 502);
  }

  const warnings = [...accepted.warnings];
  let thumbnailApplied = false;
  try {
    const thumbnail = await env.UPLOADS.get(processing.assets.thumbnail.key);
    if (!thumbnail || thumbnail.size !== processing.assets.thumbnail.size) {
      throw new Error("The temporary thumbnail was missing or changed.");
    }
    await setYouTubeThumbnail(
      accepted.videoId,
      thumbnail,
      processing.assets.thumbnail.contentType,
      accessToken,
    );
    thumbnailApplied = true;
  } catch (error) {
    warnings.push(`Custom thumbnail was not applied: ${errorMessage(error)}`);
  }

  const acceptedAt = new Date().toISOString();
  let completed = setPlatformStatus({
    ...processing,
    updatedAt: acceptedAt,
    lastError: undefined,
    youtubeResult: {
      videoId: accepted.videoId,
      acceptedAt,
      uploadStatus: accepted.uploadStatus,
      privacyStatus: "private",
      publishAt: accepted.publishAt,
      thumbnailApplied,
      mediaDeleted: false,
      warnings,
    },
  }, "youtube", "scheduled");
  await putJobWithRetry(env, completed);
  const cleanup = await cleanupReleasedMedia(env, completed);
  completed = cleanup.job;
  if (cleanup.warning && completed.youtubeResult) {
    warnings.push(cleanup.warning);
    completed = {
      ...completed,
      youtubeResult: { ...completed.youtubeResult, warnings },
    };
    await putJobWithRetry(env, completed);
  }
  await recordAppEvent(env, {
    level: warnings.length ? "warning" : "info",
    category: "youtube",
    platform: "youtube",
    jobId,
    message: warnings.length
      ? `YouTube scheduled ${accepted.videoId} with ${warnings.length} warning(s).`
      : completed.mediaDeleted
        ? `YouTube scheduled ${accepted.videoId}; temporary media deleted.`
        : `YouTube scheduled ${accepted.videoId}; temporary media retained for other selected platforms.`,
  });

  return json(completionResponse(completed));
}

function completionResponse(job: StoredJob): CompleteYouTubeResponse {
  const result = job.youtubeResult;
  if (!result) throw new Error("The scheduled job has no YouTube result.");
  return {
    id: job.id,
    status: job.status === "completed" ? "completed" : "scheduled",
    videoId: result.videoId,
    publishAt: result.publishAt,
    mediaDeleted: job.mediaDeleted ?? result.mediaDeleted ?? job.status === "scheduled_on_youtube",
    thumbnailApplied: result.thumbnailApplied,
    warnings: result.warnings ?? [],
  };
}

async function startInstagramPublish(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const job = await loadJob(env, jobId);
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (!job.platforms.instagram) return json({ error: "Instagram is not selected for this job." } satisfies ApiError, 409);
  if (job.scheduledAt && new Date(job.scheduledAt).getTime() > Date.now()) {
    return json({ error: "Instagram is scheduled and will be sent by the Worker at publish time." } satisfies ApiError, 409);
  }
  if (job.instagramResult) return json(instagramResponse(job));

  try {
    const credentials = await getInstagramCredentials(env);
    const [videoUrl, coverUrl] = await Promise.all([
      signTemporaryDownload(env, job.assets.video.key),
      signTemporaryDownload(env, job.assets.thumbnail.key),
    ]);
    const containerId = await createInstagramReelContainer(
      job,
      credentials.userId,
      credentials.accessToken,
      videoUrl,
      coverUrl,
    );
    const processing = setPlatformStatus(
      {
        ...job,
        instagramResult: {
          containerId,
          statusCode: "IN_PROGRESS",
          mediaTransferred: false,
          warnings: [],
        },
      },
      "instagram",
      "processing",
    );
    await putJobWithRetry(env, processing);
    await recordAppEvent(env, {
      level: "info",
      category: "instagram",
      platform: "instagram",
      jobId,
      message: `Instagram Reel container ${containerId} created; Meta is fetching the temporary media.`,
    });
    return json(instagramResponse(processing));
  } catch (error) {
    return platformFailureResponse(env, jobId, "instagram", error);
  }
}

async function checkInstagramPublish(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  let job = await loadJob(env, jobId);
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (!job.platforms.instagram || !job.instagramResult) {
    return json({ error: "Start the Instagram Reel transfer first." } satisfies ApiError, 409);
  }
  if (job.instagramResult.mediaId) return json(instagramResponse(job));

  try {
    const credentials = await getInstagramCredentials(env);
    const container = await getInstagramContainerStatus(
      job.instagramResult.containerId,
      credentials.accessToken,
    );
    if (["ERROR", "EXPIRED"].includes(container.statusCode)) {
      throw new Error(
        `Instagram Reel processing ${container.statusCode.toLowerCase()}${container.detail ? `: ${container.detail}` : "."}`,
      );
    }
    if (container.statusCode === "IN_PROGRESS") {
      job = {
        ...job,
        updatedAt: new Date().toISOString(),
        instagramResult: { ...job.instagramResult, statusCode: container.statusCode },
      };
      await putJobWithRetry(env, job);
      return json(instagramResponse(job));
    }
    if (container.statusCode === "PUBLISHED") {
      throw new Error("Instagram reports this container as published, but its media ID was not persisted. Check Instagram directly.");
    }
    if (container.statusCode !== "FINISHED") {
      throw new Error(`Instagram returned an unsupported container status: ${container.statusCode}.`);
    }

    job = {
      ...job,
      updatedAt: new Date().toISOString(),
      instagramResult: {
        ...job.instagramResult,
        statusCode: "FINISHED",
        mediaTransferred: true,
      },
    };
    await putJobWithRetry(env, job);
    const mediaId = await publishInstagramReel(
      credentials.userId,
      job.instagramResult!.containerId,
      credentials.accessToken,
    );
    const warnings = [
      ...(job.instagramResult?.warnings ?? []),
      ...(await verifyInstagramReel(mediaId, credentials.accessToken)),
    ];
    job = setPlatformStatus(
      {
        ...job,
        instagramResult: {
          ...job.instagramResult!,
          statusCode: "PUBLISHED",
          mediaId,
          acceptedAt: new Date().toISOString(),
          warnings,
        },
      },
      "instagram",
      "published",
    );
    await putJobWithRetry(env, job);
    const cleanup = await cleanupReleasedMedia(env, job);
    job = cleanup.job;
    if (cleanup.warning) {
      warnings.push(cleanup.warning);
      job = {
        ...job,
        instagramResult: { ...job.instagramResult!, warnings },
      };
      await putJobWithRetry(env, job);
    }
    await recordAppEvent(env, {
      level: warnings.length ? "warning" : "info",
      category: "instagram",
      platform: "instagram",
      jobId,
      message: `Instagram published Reel ${mediaId}${warnings.length ? ` with ${warnings.length} warning(s)` : ""}.`,
    });
    return json(instagramResponse(job));
  } catch (error) {
    return platformFailureResponse(env, jobId, "instagram", error);
  }
}

async function startTikTokPublish(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const job = await loadJob(env, jobId);
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (!job.platforms.tiktok) return json({ error: "TikTok is not selected for this job." } satisfies ApiError, 409);
  if (job.scheduledAt && new Date(job.scheduledAt).getTime() > Date.now()) {
    return json({ error: "TikTok is scheduled and will be sent by Social Uploader at publish time." } satisfies ApiError, 409);
  }
  if (job.tiktokResult) {
    return json({ error: "TikTok Direct Post is already initialized for this job." } satisfies ApiError, 409);
  }

  try {
    const { accessToken } = await getTikTokCredentials(env);
    const creatorInfo = await queryTikTokCreatorInfo(accessToken);
    const initialized = await initializeTikTokDirectPost(
      job,
      accessToken,
      creatorInfo,
      isTikTokAppAudited(env),
    );
    const uploading = setPlatformStatus(
      {
        ...job,
        tiktokResult: {
          publishId: initialized.publishId,
          status: "PROCESSING_UPLOAD",
          uploadCompleted: false,
          uploadedBytes: 0,
          postIds: [],
          warnings: [],
        },
      },
      "tiktok",
      "uploading",
    );
    await putJobWithRetry(env, uploading);
    await recordAppEvent(env, {
      level: "info",
      category: "tiktok",
      platform: "tiktok",
      jobId,
      message: `TikTok Direct Post ${initialized.publishId} initialized with FILE_UPLOAD and ${job.tiktok.privacy} privacy.`,
    });
    return json({
      publishId: initialized.publishId,
      uploadUrl: initialized.uploadUrl,
      chunkSize: initialized.chunkSize,
      totalChunkCount: initialized.totalChunkCount,
      creatorInfo,
    } satisfies TikTokStartResponse);
  } catch (error) {
    return platformFailureResponse(env, jobId, "tiktok", error);
  }
}

async function confirmTikTokUpload(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  let job = await loadJob(env, jobId);
  if (!job?.tiktokResult || !job.platforms.tiktok) {
    return json({ error: "Start the TikTok FILE_UPLOAD first." } satisfies ApiError, 409);
  }

  try {
    const { accessToken } = await getTikTokCredentials(env);
    const status = await fetchTikTokPostStatus(job.tiktokResult.publishId, accessToken);
    if (status.status === "FAILED") {
      throw new Error(`TikTok Direct Post failed: ${status.failReason ?? "unknown provider error"}.`);
    }
    job = setPlatformStatus(
      {
        ...job,
        tiktokResult: {
          ...job.tiktokResult,
          status: status.status,
          uploadCompleted: true,
          uploadedBytes: Math.max(status.uploadedBytes, job.assets.video.size),
          postIds: status.postIds,
        },
      },
      "tiktok",
      status.status === "PUBLISH_COMPLETE" ? "published" : "processing",
    );
    if (status.status === "PUBLISH_COMPLETE" && job.tiktokResult) {
      job = {
        ...job,
        tiktokResult: { ...job.tiktokResult, acceptedAt: new Date().toISOString() },
      };
    }
    await putJobWithRetry(env, job);
    const cleanup = await cleanupReleasedMedia(env, job);
    job = await addTikTokCleanupWarning(env, cleanup.job, cleanup.warning);
    return json(tiktokResponse(job));
  } catch (error) {
    return platformFailureResponse(env, jobId, "tiktok", error);
  }
}

async function checkTikTokPublish(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  let job = await loadJob(env, jobId);
  if (!job?.tiktokResult || !job.platforms.tiktok) {
    return json({ error: "Start the TikTok FILE_UPLOAD first." } satisfies ApiError, 409);
  }
  if (job.platformStatus?.tiktok === "published") return json(tiktokResponse(job));

  try {
    const { accessToken } = await getTikTokCredentials(env);
    const status = await fetchTikTokPostStatus(job.tiktokResult.publishId, accessToken);
    if (status.status === "FAILED") {
      throw new Error(`TikTok Direct Post failed: ${status.failReason ?? "unknown provider error"}.`);
    }
    const uploadCompleted = job.tiktokResult.uploadCompleted || status.uploadedBytes >= job.assets.video.size;
    job = setPlatformStatus(
      {
        ...job,
        tiktokResult: {
          ...job.tiktokResult,
          status: status.status,
          uploadCompleted,
          uploadedBytes: status.uploadedBytes,
          postIds: status.postIds,
          acceptedAt: status.status === "PUBLISH_COMPLETE" ? new Date().toISOString() : undefined,
        },
      },
      "tiktok",
      status.status === "PUBLISH_COMPLETE" ? "published" : "processing",
    );
    await putJobWithRetry(env, job);
    const cleanup = await cleanupReleasedMedia(env, job);
    job = await addTikTokCleanupWarning(env, cleanup.job, cleanup.warning);
    if (status.status === "PUBLISH_COMPLETE") {
      await recordAppEvent(env, {
        level: job.tiktokResult?.warnings?.length ? "warning" : "info",
        category: "tiktok",
        platform: "tiktok",
        jobId,
        message: `TikTok completed Direct Post ${job.tiktokResult!.publishId} with ${job.tiktok.privacy} privacy.`,
      });
    }
    return json(tiktokResponse(job));
  } catch (error) {
    return platformFailureResponse(env, jobId, "tiktok", error);
  }
}

function instagramResponse(job: StoredJob): InstagramPublishResponse {
  const result = job.instagramResult;
  if (!result) throw new Error("Instagram result is missing.");
  return {
    status: result.mediaId ? "published" : "processing",
    containerId: result.containerId,
    statusCode: result.statusCode,
    mediaId: result.mediaId,
    mediaDeleted: job.mediaDeleted ?? false,
    warnings: result.warnings ?? [],
  };
}

function tiktokResponse(job: StoredJob): TikTokPublishStatusResponse {
  const result = job.tiktokResult;
  if (!result) throw new Error("TikTok result is missing.");
  return {
    status: result.status,
    publishComplete: result.status === "PUBLISH_COMPLETE",
    uploadCompleted: result.uploadCompleted,
    uploadedBytes: result.uploadedBytes,
    postIds: result.postIds,
    mediaDeleted: job.mediaDeleted ?? false,
    warnings: result.warnings ?? [],
  };
}

async function addTikTokCleanupWarning(
  env: Env,
  job: StoredJob,
  warning?: string,
): Promise<StoredJob> {
  if (!warning || !job.tiktokResult) return job;
  const warnings = [...(job.tiktokResult.warnings ?? [])];
  if (!warnings.includes(warning)) warnings.push(warning);
  const updated = { ...job, tiktokResult: { ...job.tiktokResult, warnings } };
  await putJobWithRetry(env, updated);
  return updated;
}

async function platformFailureResponse(
  env: Env,
  jobId: string,
  platform: "instagram" | "tiktok",
  error: unknown,
): Promise<Response> {
  const message = errorMessage(error);
  await markPlatformFailed(env, jobId, platform, message);
  await recordAppEvent(env, {
    level: "error",
    category: platform,
    platform,
    jobId,
    message,
  });
  return json({ error: `${message} Temporary source media remains covered by 7-day cleanup.` } satisfies ApiError, 502);
}

async function signTemporaryDownload(env: Env, objectKey: string): Promise<string> {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const url = `${endpoint}/${env.R2_BUCKET_NAME}/${objectKey}?X-Amz-Expires=1800`;
  const signed = await client.sign(new Request(url), { aws: { signQuery: true } });
  return signed.url;
}

function enabledPlatforms(job: StoredJob): Platform[] {
  return (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
}

async function verifyAssets(input: DraftRequest, bucket: R2Bucket): Promise<string | null> {
  const [video, thumbnail] = await Promise.all([
    bucket.head(input.assets.video.key),
    bucket.head(input.assets.thumbnail.key),
  ]);
  if (!video || !thumbnail) return "Upload both files before creating the job.";
  if (video.size !== input.assets.video.size || thumbnail.size !== input.assets.thumbnail.size) {
    return "An uploaded file size did not match the job.";
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error.";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
