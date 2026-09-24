import type { Platform, StoredJob } from "../shared/contracts";
import type { Env } from "./env";
import { recordAppEvent } from "./events";
import { jobRequiresSource, listAllJobs, putJobWithRetry } from "./job-store";

const ABANDONED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_UPLOAD_GRACE_MS = 2 * 60 * 60 * 1000;
const JOB_ID_IN_KEY = /^(?:uploads|staging|scheduled)\/([0-9a-f-]{36})\//i;

interface StoredObject {
  key: string;
  size: number;
  uploadedAt: string;
}

export interface StorageBreakdown {
  pendingMediaBytes: number;
  pendingMediaObjectCount: number;
  orphanStagingBytes: number;
  orphanStagingObjectCount: number;
}

export async function getStorageBreakdown(
  env: Env,
  jobs?: StoredJob[],
): Promise<StorageBreakdown> {
  const knownJobs = jobs ?? await listAllJobs(env);
  const objects = await listMediaObjects(env.UPLOADS);
  const jobsById = new Map(knownJobs.map((job) => [job.id.toLowerCase(), job]));
  const breakdown: StorageBreakdown = {
    pendingMediaBytes: 0,
    pendingMediaObjectCount: 0,
    orphanStagingBytes: 0,
    orphanStagingObjectCount: 0,
  };
  for (const object of objects) {
    const job = jobForObject(object, jobsById);
    if (job && isPendingScheduledMedia(job, object.key)) {
      breakdown.pendingMediaBytes += object.size;
      breakdown.pendingMediaObjectCount += 1;
    } else {
      breakdown.orphanStagingBytes += object.size;
      breakdown.orphanStagingObjectCount += 1;
    }
  }
  return breakdown;
}

export async function reconcileStorage(env: Env, now = new Date()): Promise<{ deletedObjects: number }> {
  const [jobs, objects] = await Promise.all([listAllJobs(env), listMediaObjects(env.UPLOADS)]);
  const jobsById = new Map(jobs.map((job) => [job.id.toLowerCase(), job]));
  const deleteKeys: string[] = [];
  const abandonedJobIds = new Set<string>();

  for (const object of objects) {
    const job = jobForObject(object, jobsById);
    if (!job) {
      if (now.getTime() - new Date(object.uploadedAt).getTime() >= ABANDONED_AFTER_MS) {
        deleteKeys.push(object.key);
      }
      continue;
    }

    const currentKeys = new Set([job.assets.video.key, job.assets.thumbnail.key]);
    if (!currentKeys.has(object.key)) {
      deleteKeys.push(object.key);
      continue;
    }
    if (!jobRequiresSource(job)) {
      deleteKeys.push(object.key);
      continue;
    }
    const activeScheduled = hasPendingScheduledTransfer(job);
    const recentlyActive = now.getTime() - new Date(job.updatedAt).getTime() < ACTIVE_UPLOAD_GRACE_MS;
    if (!activeScheduled && !recentlyActive) {
      deleteKeys.push(object.key);
      abandonedJobIds.add(job.id);
    }
  }

  if (deleteKeys.length > 0) await env.UPLOADS.delete(deleteKeys);

  for (const job of jobs) {
    if (job.mediaDeleted) continue;
    if (!jobRequiresSource(job) || deleteKeys.includes(job.assets.video.key) || deleteKeys.includes(job.assets.thumbnail.key)) {
      const [video, thumbnail] = await Promise.all([
        env.UPLOADS.head(job.assets.video.key),
        env.UPLOADS.head(job.assets.thumbnail.key),
      ]);
      if (video || thumbnail) continue;
      await putJobWithRetry(env, {
        ...job,
        status: abandonedJobIds.has(job.id) ? "failed" : job.status,
        mediaDeleted: true,
        updatedAt: now.toISOString(),
        lastError: abandonedJobIds.has(job.id)
          ? "Abandoned staging media was removed by storage reconciliation."
          : job.lastError,
        platformStatus: abandonedJobIds.has(job.id)
          ? Object.fromEntries(selectedPlatforms(job).map((platform) => [platform, "failed"]))
          : job.platformStatus,
        youtubeResult: job.youtubeResult ? { ...job.youtubeResult, mediaDeleted: true } : undefined,
      });
    }
  }

  if (deleteKeys.length > 0) {
    await recordAppEvent(env, {
      level: "info",
      category: "cleanup",
      message: `Storage reconciliation deleted ${deleteKeys.length} released or expired object(s).`,
    });
  }
  return { deletedObjects: deleteKeys.length };
}

function isPendingScheduledMedia(job: StoredJob, key: string): boolean {
  if (!hasPendingScheduledTransfer(job)) return false;
  return key === job.assets.video.key || key === job.assets.thumbnail.key;
}

function hasPendingScheduledTransfer(job: StoredJob): boolean {
  if (!job.scheduledAt || isTerminal(job) || !jobRequiresSource(job)) return false;
  return (["instagram", "tiktok"] as Platform[]).some(
    (platform) => job.platforms[platform] && !["failed", "cancelled", "published"].includes(job.platformStatus?.[platform] ?? "pending"),
  );
}

function isTerminal(job: StoredJob): boolean {
  return ["completed", "partial", "failed", "cancelled"].includes(job.status);
}

function jobForObject(
  object: StoredObject,
  jobsById: ReadonlyMap<string, StoredJob>,
): StoredJob | undefined {
  const id = JOB_ID_IN_KEY.exec(object.key)?.[1]?.toLowerCase();
  return id ? jobsById.get(id) : undefined;
}

async function listMediaObjects(bucket: R2Bucket): Promise<StoredObject[]> {
  const objects: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      if (!object.key.startsWith("_system/")) {
        objects.push({ key: object.key, size: object.size, uploadedAt: object.uploaded.toISOString() });
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export function selectedPlatforms(job: StoredJob): Platform[] {
  return (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
}
