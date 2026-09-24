import { AwsClient } from "aws4fetch";
import { R2_STORAGE_CAP_BYTES } from "../shared/contracts";
import type {
  ApiError,
  AssetKind,
  CompleteYouTubeRequest,
  CompleteYouTubeResponse,
  CreateJobResponse,
  DraftRequest,
  JobStateUpdateRequest,
  PresignedUpload,
  PresignResponse,
  StoredJob,
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
  beginYouTubeOAuth,
  disconnectYouTube,
  finishYouTubeOAuth,
  getYouTubeAccessToken,
  youtubeConnectionStatus,
} from "./oauth";
import { getSystemStatus } from "./system-status";
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
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json({
      ok: true,
      service: "social-uploader",
      milestone: 2,
      storage: "temporary-r2-and-kv-metadata",
      storageCapBytes: R2_STORAGE_CAP_BYTES,
      cleanupFallbackDays: 7,
    });
  }
  if (url.pathname === "/api/system/status" && request.method === "GET") {
    return json(await getSystemStatus(env));
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

  const completionMatch = /^\/api\/jobs\/([^/]+)\/youtube\/complete$/u.exec(url.pathname);
  if (completionMatch && request.method === "POST") {
    return completeYouTubeUpload(request, env, completionMatch[1] ?? "");
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
  const objectKeys = input.files.map((file) => objectKeyFor(input.jobId, file));
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
    signUpload(client, endpoint, env.R2_BUCKET_NAME, input.jobId, filesByKind.video, capacity.expiresIn),
    signUpload(
      client,
      endpoint,
      env.R2_BUCKET_NAME,
      input.jobId,
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
  file: UploadFileRequest,
  expiresIn: number,
): Promise<PresignedUpload> {
  const objectKey = objectKeyFor(jobId, file);
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

function objectKeyFor(jobId: string, file: UploadFileRequest): string {
  return `uploads/${jobId}/${file.kind}.${extensionFor(file.kind, file.contentType)}`;
}

async function createJob(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const input = validateDraftRequest(body);
  if (!input) {
    return json(
      { error: "Invalid job. Use a future publish time, YouTube only, and a JPG or PNG thumbnail." } satisfies ApiError,
      400,
    );
  }

  const assetError = await verifyAssets(input, env.UPLOADS);
  if (assetError) return json({ error: assetError } satisfies ApiError, 409);
  if (await env.METADATA.get(jobKey(input.id))) {
    return json({ error: "A job with this ID already exists." } satisfies ApiError, 409);
  }

  const accessToken = await getYouTubeAccessToken(env);
  const uploadUrl = await startYouTubeUpload(input, accessToken);
  const now = new Date().toISOString();
  const job: StoredJob = {
    ...input,
    title: input.title.trim(),
    schemaVersion: 3,
    status: "uploading",
    createdAt: now,
    updatedAt: now,
  };
  await putJobWithRetry(env, job);
  await recordAppEvent(env, {
    level: "info",
    category: "upload",
    platform: "youtube",
    jobId: job.id,
    message: "YouTube upload session created; browser upload started.",
  });

  return json({
    id: job.id,
    status: "uploading",
    youtube: { uploadUrl, accessToken },
  } satisfies CreateJobResponse, 201);
}

async function getJob(env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const job = await env.METADATA.get<StoredJob>(jobKey(jobId), "json");
  return job ? json(job) : json({ error: "Job not found." } satisfies ApiError, 404);
}

async function updateJobState(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as Partial<JobStateUpdateRequest> | null;
  if (!body || !["failed", "cancelled"].includes(body.status ?? "")) {
    return json({ error: "Invalid job state." } satisfies ApiError, 400);
  }
  const job = await env.METADATA.get<StoredJob>(jobKey(jobId), "json");
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (["scheduled", "scheduled_on_youtube"].includes(job.status)) return json(job);

  const status = body.status as JobStateUpdateRequest["status"];
  const updated: StoredJob = {
    ...job,
    status,
    updatedAt: new Date().toISOString(),
    lastError: body.error?.slice(0, 500),
  };
  await putJobWithRetry(env, updated);
  await recordAppEvent(env, {
    level: status === "failed" ? "error" : "warning",
    category: "upload",
    platform: "youtube",
    jobId,
    message: status === "failed" ? updated.lastError ?? "Upload failed." : "Upload cancelled by user.",
  });
  return json(updated);
}

async function completeYouTubeUpload(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as Partial<CompleteYouTubeRequest> | null;
  if (!body || typeof body.videoId !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(body.videoId)) {
    return json({ error: "Invalid YouTube video ID." } satisfies ApiError, 400);
  }

  const job = await env.METADATA.get<StoredJob>(jobKey(jobId), "json");
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (["scheduled", "scheduled_on_youtube"].includes(job.status) && job.youtubeResult) {
    return json(completionResponse(job));
  }
  if (job.youtubeVideoId && job.youtubeVideoId !== body.videoId) {
    return json({ error: "This job is already associated with a different YouTube video." } satisfies ApiError, 409);
  }

  const processing: StoredJob = {
    ...job,
    schemaVersion: 3,
    status: "processing",
    youtubeVideoId: body.videoId,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  };
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
    const failed: StoredJob = {
      ...processing,
      status: "failed",
      updatedAt: new Date().toISOString(),
      lastError: message,
    };
    await putJobWithRetry(env, failed);
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

  let mediaDeleted = false;
  try {
    await env.UPLOADS.delete([processing.assets.video.key, processing.assets.thumbnail.key]);
    const [video, thumbnail] = await Promise.all([
      env.UPLOADS.head(processing.assets.video.key),
      env.UPLOADS.head(processing.assets.thumbnail.key),
    ]);
    mediaDeleted = !video && !thumbnail;
    if (!mediaDeleted) warnings.push("YouTube accepted the schedule, but temporary R2 cleanup is incomplete.");
  } catch (error) {
    warnings.push(`YouTube accepted the schedule, but temporary R2 cleanup failed: ${errorMessage(error)}`);
  }

  const acceptedAt = new Date().toISOString();
  const completed: StoredJob = {
    ...processing,
    status: "scheduled",
    updatedAt: acceptedAt,
    lastError: undefined,
    youtubeResult: {
      videoId: accepted.videoId,
      acceptedAt,
      uploadStatus: accepted.uploadStatus,
      privacyStatus: "private",
      publishAt: accepted.publishAt,
      thumbnailApplied,
      mediaDeleted,
      warnings,
    },
  };
  try {
    await putJobWithRetry(env, completed);
  } catch (error) {
    warnings.push(`Schedule succeeded, but status persistence needs a retry: ${errorMessage(error)}`);
  }
  await recordAppEvent(env, {
    level: warnings.length ? "warning" : "info",
    category: "youtube",
    platform: "youtube",
    jobId,
    message: warnings.length
      ? `YouTube scheduled ${accepted.videoId} with ${warnings.length} warning(s).`
      : `YouTube scheduled ${accepted.videoId}; temporary media deleted.`,
  });

  return json(completionResponse(completed));
}

function completionResponse(job: StoredJob): CompleteYouTubeResponse {
  const result = job.youtubeResult;
  if (!result) throw new Error("The scheduled job has no YouTube result.");
  return {
    id: job.id,
    status: "scheduled",
    videoId: result.videoId,
    publishAt: result.publishAt,
    mediaDeleted: result.mediaDeleted ?? job.status === "scheduled_on_youtube",
    thumbnailApplied: result.thumbnailApplied,
    warnings: result.warnings ?? [],
  };
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

async function putJobWithRetry(env: Env, job: StoredJob): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await env.METADATA.put(jobKey(job.id), JSON.stringify(job));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await wait(1100);
    }
  }
  throw lastError;
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

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected server error.";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
