import type {
  JobStatus,
  Platform,
  StoredJob,
  SystemJobSummary,
  SystemStatusResponse,
} from "../shared/contracts";
import { getTemporaryStorageMetrics } from "./capacity";
import type { Env } from "./env";
import { listAppEvents } from "./events";
import { instagramConnectionStatus } from "./instagram-oauth";
import { listAllJobs } from "./job-store";
import { youtubeConnectionStatus } from "./oauth";
import { getStorageBreakdown } from "./reconciliation";
import { listSchedulerRuns } from "./scheduler";
import { tiktokConnectionStatus } from "./tiktok-oauth";

export async function getSystemStatus(env: Env): Promise<SystemStatusResponse> {
  const allJobsPromise = listAllJobs(env);
  const [storage, allJobs, events, youtube, instagram, tiktok, recentRuns] = await Promise.all([
    getTemporaryStorageMetrics(env.UPLOADS),
    allJobsPromise,
    listAppEvents(env, 50),
    youtubeConnectionStatus(env),
    instagramConnectionStatus(env),
    tiktokConnectionStatus(env),
    listSchedulerRuns(env),
  ]);
  const breakdown = await getStorageBreakdown(env, allJobs);
  const pending = allJobs.filter(isPendingScheduledJob);

  return {
    generatedAt: new Date().toISOString(),
    storage,
    connections: {
      youtube: youtube.connected,
      instagram: instagram.connected,
      tiktok: tiktok.connected,
    },
    scheduling: {
      pendingCount: pending.length,
      failedCount: allJobs.filter((job) =>
        Object.values(job.platformStatus ?? {}).some((status) => status === "failed")
      ).length,
      nextPublishAt: pending.map((job) => job.scheduledAt!).sort()[0] ?? null,
      ...breakdown,
      recentRuns,
    },
    platformResults: platformResults(allJobs),
    jobs: allJobs
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50)
      .map(summarizeJob),
    recentErrors: events.filter((event) => event.level === "error").slice(0, 20),
    events,
    localWorker: { configured: false },
  };
}

function summarizeJob(job: StoredJob): SystemJobSummary {
  const platforms = (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
  const platform = platforms[0] ?? "youtube";
  return {
    id: job.id,
    title: job.title,
    platform,
    platforms,
    status: normalizeStatus(job.status),
    fileSizeBytes: job.assets.video.size,
    createdAt: job.createdAt,
    scheduledAt: job.youtubeResult?.publishAt ?? job.scheduledAt,
    temporaryMediaDeleted: job.mediaDeleted ?? job.youtubeResult?.mediaDeleted ?? false,
    videoId: job.youtubeResult?.videoId ?? job.instagramResult?.mediaId ?? job.tiktokResult?.postIds[0],
    lastError: job.lastError,
  };
}

function normalizeStatus(status: JobStatus): SystemJobSummary["status"] {
  if (status === "uploading_to_youtube") return "uploading";
  if (status === "scheduled_on_youtube") return "scheduled";
  return status;
}

function isPendingScheduledJob(job: StoredJob): boolean {
  if (!job.scheduledAt || ["cancelled", "completed", "failed"].includes(job.status)) return false;
  return (Object.entries(job.platforms) as Array<[Platform, boolean]>).some(
    ([platform, enabled]) => enabled && ["pending", "uploading", "processing", "scheduled"].includes(job.platformStatus?.[platform] ?? "pending"),
  );
}

function platformResults(
  jobs: StoredJob[],
): SystemStatusResponse["platformResults"] {
  const result: SystemStatusResponse["platformResults"] = {
    youtube: { succeeded: 0, failed: 0, pending: 0 },
    instagram: { succeeded: 0, failed: 0, pending: 0 },
    tiktok: { succeeded: 0, failed: 0, pending: 0 },
  };
  for (const job of jobs) {
    for (const platform of ["youtube", "instagram", "tiktok"] as Platform[]) {
      if (!job.platforms[platform]) continue;
      const status = job.platformStatus?.[platform] ?? "pending";
      if (["scheduled", "published"].includes(status)) result[platform].succeeded += 1;
      else if (status === "failed") result[platform].failed += 1;
      else if (status !== "cancelled") result[platform].pending += 1;
    }
  }
  return result;
}
