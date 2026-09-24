import { AwsClient } from "aws4fetch";
import { R2_STORAGE_CAP_BYTES } from "../shared/contracts";
import type {
  ApiError,
  AssetKind,
  CompleteYouTubeRequest,
  CompleteYouTubeResponse,
  CreateJobResponse,
  DraftRequest,
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
import {
  beginYouTubeOAuth,
  disconnectYouTube,
  finishYouTubeOAuth,
  getYouTubeAccessToken,
  youtubeConnectionStatus,
} from "./oauth";
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
      const message = error instanceof Error ? error.message : "Unexpected server error.";
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
    return json({ disconnected: true });
  }
  if (url.pathname === "/api/uploads/presign" && request.method === "POST") {
    return createPresignedUpload(request, env);
  }
  if (url.pathname === "/api/jobs" && request.method === "POST") {
    return createJob(request, env);
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
    schemaVersion: 2,
    status: "uploading_to_youtube",
    createdAt: now,
    updatedAt: now,
  };
  await env.METADATA.put(jobKey(input.id), JSON.stringify(job));

  return json({
    id: job.id,
    status: "uploading_to_youtube",
    youtube: { uploadUrl, accessToken },
  } satisfies CreateJobResponse, 201);
}

async function completeYouTubeUpload(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!UUID_PATTERN.test(jobId)) return json({ error: "Invalid job ID." } satisfies ApiError, 400);
  const body = (await readJson(request)) as Partial<CompleteYouTubeRequest> | null;
  if (!body || typeof body.videoId !== "string" || !YOUTUBE_VIDEO_ID_PATTERN.test(body.videoId)) {
    return json({ error: "Invalid YouTube video ID." } satisfies ApiError, 400);
  }

  const job = await env.METADATA.get<StoredJob>(jobKey(jobId), "json");
  if (!job) return json({ error: "Job not found." } satisfies ApiError, 404);
  if (job.status === "scheduled_on_youtube" && job.youtubeResult) {
    return json({
      id: job.id,
      status: "scheduled_on_youtube",
      videoId: job.youtubeResult.videoId,
      publishAt: job.youtubeResult.publishAt,
      mediaDeleted: true,
    } satisfies CompleteYouTubeResponse);
  }

  const thumbnail = await env.UPLOADS.get(job.assets.thumbnail.key);
  if (!thumbnail || thumbnail.size !== job.assets.thumbnail.size) {
    return json({ error: "The temporary thumbnail is missing or changed." } satisfies ApiError, 409);
  }

  const accessToken = await getYouTubeAccessToken(env);
  await setYouTubeThumbnail(body.videoId, thumbnail, job.assets.thumbnail.contentType, accessToken);
  const accepted = await verifyYouTubeSchedule(body.videoId, job, accessToken);

  await env.UPLOADS.delete([job.assets.video.key, job.assets.thumbnail.key]);
  const acceptedAt = new Date().toISOString();
  const completed: StoredJob = {
    ...job,
    status: "scheduled_on_youtube",
    updatedAt: acceptedAt,
    youtubeResult: {
      videoId: accepted.videoId,
      acceptedAt,
      uploadStatus: accepted.uploadStatus,
      privacyStatus: "private",
      publishAt: accepted.publishAt,
      thumbnailApplied: true,
    },
  };
  await env.METADATA.put(jobKey(job.id), JSON.stringify(completed));

  return json({
    id: job.id,
    status: "scheduled_on_youtube",
    videoId: accepted.videoId,
    publishAt: accepted.publishAt,
    mediaDeleted: true,
  } satisfies CompleteYouTubeResponse);
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

function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
