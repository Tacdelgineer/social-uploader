import type { Platform, PlatformJobStatus, StoredJob } from "../shared/contracts";
import type { Env } from "./env";

export function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export async function loadJob(env: Env, jobId: string): Promise<StoredJob | null> {
  return env.METADATA.get<StoredJob>(jobKey(jobId), "json");
}

export async function putJobWithRetry(env: Env, job: StoredJob): Promise<void> {
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

export async function markPlatformFailed(
  env: Env,
  jobId: string,
  platform: Platform,
  error: string,
): Promise<StoredJob | null> {
  const job = await loadJob(env, jobId);
  if (!job || !job.platforms[platform]) return job;
  const updated = normalizeOverallStatus({
    ...job,
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    lastError: error.slice(0, 500),
    platformStatus: { ...job.platformStatus, [platform]: "failed" },
    platformErrors: { ...job.platformErrors, [platform]: error.slice(0, 500) },
  });
  await putJobWithRetry(env, updated);
  return updated;
}

export function setPlatformStatus(
  job: StoredJob,
  platform: Platform,
  status: PlatformJobStatus,
): StoredJob {
  return normalizeOverallStatus({
    ...job,
    schemaVersion: 4,
    updatedAt: new Date().toISOString(),
    lastError: undefined,
    platformStatus: { ...job.platformStatus, [platform]: status },
    platformErrors: { ...job.platformErrors, [platform]: undefined },
  });
}

export function normalizeOverallStatus(job: StoredJob): StoredJob {
  const selected = (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
  const states = selected.map((platform) => job.platformStatus?.[platform] ?? "pending");
  const successes = states.filter((state) => state === "scheduled" || state === "published").length;
  const failures = states.filter((state) => state === "failed").length;
  let status: StoredJob["status"];
  if (successes === states.length) status = "completed";
  else if (successes + failures === states.length) status = successes > 0 ? "partial" : "failed";
  else if (states.some((state) => state === "uploading")) status = "uploading";
  else status = "processing";
  return { ...job, status };
}

export async function cleanupReleasedMedia(
  env: Env,
  job: StoredJob,
): Promise<{ job: StoredJob; warning?: string }> {
  if (job.mediaDeleted) return { job };
  const released = (Object.entries(job.platforms) as Array<[Platform, boolean]>).every(
    ([platform, enabled]) => !enabled || sourceReleased(job, platform),
  );
  if (!released) return { job };

  try {
    await env.UPLOADS.delete([job.assets.video.key, job.assets.thumbnail.key]);
    const [video, thumbnail] = await Promise.all([
      env.UPLOADS.head(job.assets.video.key),
      env.UPLOADS.head(job.assets.thumbnail.key),
    ]);
    if (video || thumbnail) {
      return { job, warning: "All providers have the media, but temporary R2 cleanup is incomplete." };
    }
    const updated: StoredJob = {
      ...job,
      mediaDeleted: true,
      updatedAt: new Date().toISOString(),
      youtubeResult: job.youtubeResult ? { ...job.youtubeResult, mediaDeleted: true } : undefined,
    };
    await putJobWithRetry(env, updated);
    return { job: updated };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unexpected cleanup error";
    return { job, warning: `All providers have the media, but temporary R2 cleanup failed: ${detail}` };
  }
}

function sourceReleased(job: StoredJob, platform: Platform): boolean {
  if (platform === "youtube") return Boolean(job.youtubeResult);
  if (platform === "instagram") return job.instagramResult?.mediaTransferred === true;
  return job.tiktokResult?.uploadCompleted === true;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
