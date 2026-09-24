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
import { youtubeConnectionStatus } from "./oauth";
import { tiktokConnectionStatus } from "./tiktok-oauth";

const JOB_PREFIX = "job:";

export async function getSystemStatus(env: Env): Promise<SystemStatusResponse> {
  const [storage, jobs, events, youtube, instagram, tiktok] = await Promise.all([
    getTemporaryStorageMetrics(env.UPLOADS),
    listRecentJobs(env),
    listAppEvents(env, 50),
    youtubeConnectionStatus(env),
    instagramConnectionStatus(env),
    tiktokConnectionStatus(env),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    storage,
    connections: {
      youtube: youtube.connected,
      instagram: instagram.connected,
      tiktok: tiktok.connected,
    },
    jobs,
    recentErrors: events.filter((event) => event.level === "error").slice(0, 20),
    events,
    localWorker: { configured: false },
  };
}

async function listRecentJobs(env: Env): Promise<SystemJobSummary[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.METADATA.list({ prefix: JOB_PREFIX, cursor, limit: 1000 });
    names.push(...page.keys.map((item) => item.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && names.length < 1000);

  const stored = await Promise.all(
    names.slice(0, 100).map((name) => env.METADATA.get<StoredJob>(name, "json")),
  );
  return stored
    .filter((job): job is StoredJob => job !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 50)
    .map(summarizeJob);
}

function summarizeJob(job: StoredJob): SystemJobSummary {
  const platforms = (Object.entries(job.platforms) as Array<[Platform, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([platform]) => platform);
  const platform = platforms[0] ?? "youtube";
  return {
    id: job.id,
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
