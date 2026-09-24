import { AwsClient } from "aws4fetch";
import type { Platform, SchedulerRun, StoredJob } from "../shared/contracts";
import { decryptJson, encryptJson } from "./crypto";
import type { Env } from "./env";
import { recordAppEvent } from "./events";
import { getInstagramCredentials } from "./instagram-oauth";
import {
  createInstagramReelContainer,
  getInstagramContainerStatus,
  publishInstagramReel,
  verifyInstagramReel,
} from "./instagram";
import {
  cleanupReleasedMedia,
  listAllJobs,
  loadJob,
  normalizeOverallStatus,
  putJobWithRetry,
  setPlatformStatus,
} from "./job-store";
import { reconcileStorage } from "./reconciliation";
import { getTikTokCredentials } from "./tiktok-oauth";
import {
  fetchTikTokPostStatus,
  initializeTikTokDirectPost,
  queryTikTokCreatorInfo,
} from "./tiktok";

const RUNS_KEY = "scheduler:runs";
const MAX_RUNS = 12;
const MAX_DUE_JOBS_PER_RUN = 10;
const MAX_TIKTOK_CHUNKS_PER_RUN = 16;
const MAX_ATTEMPTS = 3;

export async function runScheduler(env: Env, scheduledTime = Date.now()): Promise<SchedulerRun> {
  const startedAt = new Date().toISOString();
  const jobs = await listAllJobs(env);
  const due = jobs
    .filter((job) => isDue(job, scheduledTime))
    .sort((left, right) => (left.scheduledAt ?? "").localeCompare(right.scheduledAt ?? ""))
    .slice(0, MAX_DUE_JOBS_PER_RUN);
  let processedPlatforms = 0;
  let succeeded = 0;
  let failed = 0;
  let tiktokClaimed = false;

  for (const candidate of due) {
    let job = (await loadJob(env, candidate.id)) ?? candidate;
    if (job.status === "cancelled") continue;

    if (job.platforms.instagram && ["pending", "processing"].includes(job.platformStatus?.instagram ?? "pending")) {
      processedPlatforms += 1;
      try {
        job = await processInstagramStep(env, job);
        if (job.platformStatus?.instagram === "published") succeeded += 1;
      } catch (error) {
        failed += 1;
        job = await recordScheduledFailure(env, job, "instagram", error);
      }
    }

    if (
      !tiktokClaimed &&
      job.platforms.tiktok &&
      ["pending", "uploading", "processing"].includes(job.platformStatus?.tiktok ?? "pending")
    ) {
      tiktokClaimed = true;
      processedPlatforms += 1;
      try {
        job = await processTikTokStep(env, job);
        if (job.platformStatus?.tiktok === "published") succeeded += 1;
      } catch (error) {
        failed += 1;
        await recordScheduledFailure(env, job, "tiktok", error);
      }
    }
  }

  const reconciliation = await reconcileStorage(env, new Date(scheduledTime));
  const run: SchedulerRun = {
    startedAt,
    finishedAt: new Date().toISOString(),
    dueJobs: due.length,
    processedPlatforms,
    succeeded,
    failed,
    deletedObjects: reconciliation.deletedObjects,
  };
  await storeSchedulerRun(env, run);
  return run;
}

export async function listSchedulerRuns(env: Env): Promise<SchedulerRun[]> {
  return (await env.METADATA.get<SchedulerRun[]>(RUNS_KEY, "json")) ?? [];
}

async function processInstagramStep(env: Env, job: StoredJob): Promise<StoredJob> {
  const credentials = await getInstagramCredentials(env);
  if (!job.instagramResult) {
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
    const created = setPlatformStatus({
      ...job,
      schemaVersion: 5,
      instagramResult: {
        containerId,
        statusCode: "IN_PROGRESS",
        mediaTransferred: false,
        warnings: [],
      },
      schedulerAttempts: { ...job.schedulerAttempts, instagram: 0 },
      lastSchedulerAttemptAt: new Date().toISOString(),
    }, "instagram", "processing");
    await putJobWithRetry(env, created);
    return created;
  }

  const container = await getInstagramContainerStatus(
    job.instagramResult.containerId,
    credentials.accessToken,
  );
  if (["ERROR", "EXPIRED"].includes(container.statusCode)) {
    throw new Error(`Instagram Reel processing ${container.statusCode.toLowerCase()}${container.detail ? `: ${container.detail}` : "."}`);
  }
  if (container.statusCode === "IN_PROGRESS") {
    const updated = { ...job, updatedAt: new Date().toISOString(), instagramResult: { ...job.instagramResult, statusCode: container.statusCode } };
    await putJobWithRetry(env, updated);
    return updated;
  }
  if (container.statusCode !== "FINISHED") {
    throw new Error(`Instagram returned an unsupported container status: ${container.statusCode}.`);
  }

  let transferred: StoredJob = {
    ...job,
    instagramResult: { ...job.instagramResult, statusCode: "FINISHED", mediaTransferred: true },
    updatedAt: new Date().toISOString(),
  };
  await putJobWithRetry(env, transferred);
  transferred = (await cleanupReleasedMedia(env, transferred)).job;
  const mediaId = await publishInstagramReel(
    credentials.userId,
    transferred.instagramResult!.containerId,
    credentials.accessToken,
  );
  const warnings = await verifyInstagramReel(mediaId, credentials.accessToken);
  const published = setPlatformStatus({
    ...transferred,
    instagramResult: {
      ...transferred.instagramResult!,
      statusCode: "PUBLISHED",
      mediaId,
      acceptedAt: new Date().toISOString(),
      warnings,
    },
    schedulerAttempts: { ...transferred.schedulerAttempts, instagram: 0 },
  }, "instagram", "published");
  await putJobWithRetry(env, published);
  await recordAppEvent(env, {
    level: warnings.length ? "warning" : "info",
    category: "instagram",
    platform: "instagram",
    jobId: job.id,
    message: `Scheduler published Instagram Reel ${mediaId}.`,
  });
  return published;
}

async function processTikTokStep(env: Env, job: StoredJob): Promise<StoredJob> {
  const { accessToken } = await getTikTokCredentials(env);
  let current = job;
  if (!current.tiktokResult) {
    const creator = await queryTikTokCreatorInfo(accessToken);
    const initialized = await initializeTikTokDirectPost(current, accessToken, creator);
    const encryptedUploadUrl = await encryptJson(
      { uploadUrl: initialized.uploadUrl },
      env.OAUTH_ENCRYPTION_KEY,
    );
    current = setPlatformStatus({
      ...current,
      schemaVersion: 5,
      tiktokResult: {
        publishId: initialized.publishId,
        status: "PROCESSING_UPLOAD",
        uploadCompleted: false,
        uploadedBytes: 0,
        postIds: [],
        warnings: [],
        encryptedUploadUrl,
        chunkSize: initialized.chunkSize,
        totalChunkCount: initialized.totalChunkCount,
      },
      schedulerAttempts: { ...current.schedulerAttempts, tiktok: 0 },
      lastSchedulerAttemptAt: new Date().toISOString(),
    }, "tiktok", "uploading");
    await putJobWithRetry(env, current);
  }

  const result = current.tiktokResult!;
  let status = await fetchTikTokPostStatus(result.publishId, accessToken);
  if (status.status === "FAILED") {
    throw new Error(`TikTok Direct Post failed: ${status.failReason ?? "unknown provider error"}.`);
  }

  if (!result.uploadCompleted) {
    if (!result.encryptedUploadUrl || !result.chunkSize || !result.totalChunkCount) {
      throw new Error("The scheduled TikTok upload session is incomplete.");
    }
    const { uploadUrl } = await decryptJson<{ uploadUrl: string }>(
      result.encryptedUploadUrl,
      env.OAUTH_ENCRYPTION_KEY,
    );
    let uploadedBytes = Math.max(result.uploadedBytes, status.uploadedBytes);
    let chunkIndex = Math.floor(uploadedBytes / result.chunkSize);
    let uploadedThisRun = 0;
    while (uploadedBytes < current.assets.video.size && uploadedThisRun < MAX_TIKTOK_CHUNKS_PER_RUN) {
      const start = chunkIndex * result.chunkSize;
      const end = chunkIndex === result.totalChunkCount - 1
        ? current.assets.video.size
        : Math.min(current.assets.video.size, start + result.chunkSize);
      const chunk = await env.UPLOADS.get(current.assets.video.key, {
        range: { offset: start, length: end - start },
      });
      if (!chunk) throw new Error("Scheduled TikTok source video is missing from R2.");
      const response = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": current.assets.video.contentType,
          "content-length": String(end - start),
          "content-range": `bytes ${start}-${end - 1}/${current.assets.video.size}`,
        },
        body: chunk.body,
      });
      const expected = end === current.assets.video.size ? 201 : 206;
      if (response.status !== expected) {
        throw new Error(`TikTok rejected scheduled FILE_UPLOAD chunk ${chunkIndex + 1}/${result.totalChunkCount} (HTTP ${response.status}).`);
      }
      uploadedBytes = end;
      chunkIndex += 1;
      uploadedThisRun += 1;
    }
    const uploadCompleted = uploadedBytes >= current.assets.video.size;
    current = setPlatformStatus({
      ...current,
      tiktokResult: { ...result, uploadCompleted, uploadedBytes },
      schedulerAttempts: { ...current.schedulerAttempts, tiktok: 0 },
      lastSchedulerAttemptAt: new Date().toISOString(),
    }, "tiktok", uploadCompleted ? "processing" : "uploading");
    await putJobWithRetry(env, current);
    if (uploadCompleted) current = (await cleanupReleasedMedia(env, current)).job;
    if (!uploadCompleted) return current;
    status = await fetchTikTokPostStatus(result.publishId, accessToken);
  }

  const published = status.status === "PUBLISH_COMPLETE";
  current = setPlatformStatus({
    ...current,
    tiktokResult: {
      ...current.tiktokResult!,
      status: status.status,
      uploadCompleted: true,
      uploadedBytes: Math.max(status.uploadedBytes, current.assets.video.size),
      postIds: status.postIds,
      acceptedAt: published ? new Date().toISOString() : current.tiktokResult?.acceptedAt,
      encryptedUploadUrl: undefined,
    },
    schedulerAttempts: { ...current.schedulerAttempts, tiktok: 0 },
    lastSchedulerAttemptAt: new Date().toISOString(),
  }, "tiktok", published ? "published" : "processing");
  await putJobWithRetry(env, current);
  current = (await cleanupReleasedMedia(env, current)).job;
  if (published) {
    await recordAppEvent(env, {
      level: "info",
      category: "tiktok",
      platform: "tiktok",
      jobId: current.id,
      message: `Scheduler completed TikTok Direct Post ${result.publishId} as SELF_ONLY.`,
    });
  }
  return current;
}

async function recordScheduledFailure(
  env: Env,
  job: StoredJob,
  platform: Platform,
  error: unknown,
): Promise<StoredJob> {
  const base = (await loadJob(env, job.id)) ?? job;
  const message = error instanceof Error ? error.message : "Unexpected scheduler error.";
  const attempts = (base.schedulerAttempts?.[platform] ?? 0) + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  const updated = normalizeOverallStatus({
    ...base,
    schemaVersion: 5,
    updatedAt: new Date().toISOString(),
    lastSchedulerAttemptAt: new Date().toISOString(),
    lastError: message.slice(0, 500),
    schedulerAttempts: { ...base.schedulerAttempts, [platform]: attempts },
    platformStatus: {
      ...base.platformStatus,
      [platform]: terminal ? "failed" : base.platformStatus?.[platform] ?? "pending",
    },
    platformErrors: { ...base.platformErrors, [platform]: message.slice(0, 500) },
  });
  await putJobWithRetry(env, updated);
  await recordAppEvent(env, {
    level: terminal ? "error" : "warning",
    category: platform,
    platform,
    jobId: base.id,
    message: `Scheduled publish attempt ${attempts}/${MAX_ATTEMPTS} failed: ${message}`,
  });
  return updated;
}

async function signTemporaryDownload(env: Env, objectKey: string): Promise<string> {
  const endpoint = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const signed = await client.sign(
    new Request(`${endpoint}/${env.R2_BUCKET_NAME}/${objectKey}?X-Amz-Expires=1800`),
    { aws: { signQuery: true } },
  );
  return signed.url;
}

function isDue(job: StoredJob, scheduledTime: number): boolean {
  if (!job.scheduledAt || new Date(job.scheduledAt).getTime() > scheduledTime) return false;
  if (["cancelled", "completed", "failed"].includes(job.status)) return false;
  return (["instagram", "tiktok"] as Platform[]).some(
    (platform) => job.platforms[platform] && ["pending", "uploading", "processing"].includes(job.platformStatus?.[platform] ?? "pending"),
  );
}

async function storeSchedulerRun(env: Env, run: SchedulerRun): Promise<void> {
  const current = (await env.METADATA.get<SchedulerRun[]>(RUNS_KEY, "json")) ?? [];
  await env.METADATA.put(RUNS_KEY, JSON.stringify([run, ...current].slice(0, MAX_RUNS)));
}
