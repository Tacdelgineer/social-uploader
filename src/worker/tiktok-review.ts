import type { TikTokReviewStatus } from "../shared/contracts";
import type { Env } from "./env";
import { listAllJobs } from "./job-store";
import { queryTikTokCreatorInfo } from "./tiktok";
import { getTikTokCredentials, tiktokLoginKitConfigured } from "./tiktok-oauth";

export function isTikTokAppAudited(env: Env): boolean {
  return env.TIKTOK_APP_AUDITED?.trim().toLowerCase() === "true";
}

export async function getTikTokReviewStatus(env: Env): Promise<TikTokReviewStatus> {
  const jobsPromise = listAllJobs(env);
  let videoPublishScopeGranted = false;
  let creatorInfoWorking = false;
  let creatorInfo: TikTokReviewStatus["creatorInfo"];
  let creatorInfoError: string | undefined;

  try {
    const credentials = await getTikTokCredentials(env);
    videoPublishScopeGranted = new Set(
      credentials.scope.split(",").map((scope) => scope.trim()),
    ).has("video.publish");
    if (videoPublishScopeGranted) {
      creatorInfo = await queryTikTokCreatorInfo(credentials.accessToken);
      creatorInfoWorking = true;
    }
  } catch (error) {
    creatorInfoError = error instanceof Error ? error.message : "TikTok review checks are unavailable.";
  }

  const jobs = await jobsPromise;
  return {
    loginKitConfigured: tiktokLoginKitConfigured(env),
    videoPublishScopeGranted,
    creatorInfoWorking,
    directPostInitialized: jobs.some((job) => Boolean(job.tiktokResult?.publishId)),
    appRestriction: isTikTokAppAudited(env) ? "approved" : "unaudited",
    creatorInfo,
    creatorInfoError,
  };
}
