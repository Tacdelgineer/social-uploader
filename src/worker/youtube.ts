import type { DraftRequest } from "../shared/contracts";

interface YouTubeVideo {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    categoryId?: string;
    tags?: string[];
    defaultLanguage?: string;
  };
  status?: {
    uploadStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
    privacyStatus?: string;
    publishAt?: string;
    selfDeclaredMadeForKids?: boolean;
    embeddable?: boolean;
    license?: string;
    publicStatsViewable?: boolean;
    containsSyntheticMedia?: boolean;
  };
}

interface VideoListResponse {
  items?: YouTubeVideo[];
  error?: { message?: string };
}

export interface AcceptedYouTubeVideo {
  videoId: string;
  uploadStatus: string;
  publishAt: string;
  warnings: string[];
}

export async function startYouTubeUpload(
  input: DraftRequest,
  accessToken: string,
): Promise<string> {
  const response = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-length": String(input.assets.video.size),
        "x-upload-content-type": input.assets.video.contentType,
      },
      body: JSON.stringify({
        snippet: { title: input.title.trim(), description: input.description },
        status: {
          privacyStatus: "private",
          publishAt: input.scheduledAt,
          selfDeclaredMadeForKids: input.youtube.madeForKids,
        },
      }),
    },
  );
  if (!response.ok) throw new Error(await googleError(response, "YouTube refused the upload session."));
  const uploadUrl = response.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL.");
  return uploadUrl;
}

export async function setYouTubeThumbnail(
  videoId: string,
  thumbnail: R2ObjectBody,
  contentType: string,
  accessToken: string,
): Promise<void> {
  const url = new URL("https://www.googleapis.com/upload/youtube/v3/thumbnails/set");
  url.searchParams.set("videoId", videoId);
  url.searchParams.set("uploadType", "media");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": contentType,
      "content-length": String(thumbnail.size),
    },
    body: thumbnail.body,
  });
  if (!response.ok) throw new Error(await googleError(response, "YouTube rejected the custom thumbnail."));
  const result = (await response.json()) as { items?: unknown[] };
  if (!result.items?.length) throw new Error("YouTube did not confirm the custom thumbnail.");
}

export async function verifyYouTubeSchedule(
  videoId: string,
  input: DraftRequest,
  accessToken: string,
): Promise<AcceptedYouTubeVideo> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("id", videoId);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await wait(attempt * 400);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
      if (!response.ok) {
        throw new Error(await googleError(response, "Could not verify the YouTube upload."));
      }
      const payload = (await response.json()) as VideoListResponse;
      const video = payload.items?.[0];
      if (!video) throw new Error("YouTube has not returned the uploaded video yet.");
      return assertScheduledVideoAccepted(video, input, videoId);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Could not verify the YouTube upload.");
    }
  }
  throw lastError ?? new Error("Could not verify the YouTube upload.");
}

export async function uploadYouTubeVideoFromR2(
  input: DraftRequest,
  video: R2ObjectBody,
  accessToken: string,
): Promise<string> {
  const uploadUrl = await startYouTubeUpload(input, accessToken);
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": input.assets.video.contentType,
      "content-length": String(video.size),
    },
    body: video.body,
  });
  if (!response.ok) throw new Error(await googleError(response, "YouTube upload failed."));
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("YouTube did not return a video ID after upload.");
  return payload.id;
}

export async function updateYouTubeScheduledVideo(
  videoId: string,
  input: DraftRequest,
  accessToken: string,
): Promise<AcceptedYouTubeVideo> {
  const existing = await getYouTubeVideo(videoId, accessToken);
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,status");
  const snippet = compact({
    title: input.title.trim(),
    description: input.description,
    categoryId: existing.snippet?.categoryId ?? "22",
    tags: existing.snippet?.tags,
    defaultLanguage: existing.snippet?.defaultLanguage,
  });
  const status = compact({
    privacyStatus: "private",
    publishAt: input.scheduledAt,
    selfDeclaredMadeForKids: input.youtube.madeForKids,
    embeddable: existing.status?.embeddable,
    license: existing.status?.license,
    publicStatsViewable: existing.status?.publicStatsViewable,
    containsSyntheticMedia: existing.status?.containsSyntheticMedia,
  });
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({ id: videoId, snippet, status }),
  });
  if (!response.ok) throw new Error(await googleError(response, "YouTube rejected the scheduled post update."));
  const updated = (await response.json()) as YouTubeVideo;
  return assertScheduledVideoAccepted(updated, input, videoId);
}

export async function deleteYouTubeVideo(videoId: string, accessToken: string): Promise<void> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("id", videoId);
  const response = await fetch(url, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(await googleError(response, "YouTube could not delete the scheduled video."));
  }
}

async function getYouTubeVideo(videoId: string, accessToken: string): Promise<YouTubeVideo> {
  const url = new URL("https://www.googleapis.com/youtube/v3/videos");
  url.searchParams.set("part", "snippet,status");
  url.searchParams.set("id", videoId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await googleError(response, "Could not load the scheduled YouTube video."));
  const payload = (await response.json()) as VideoListResponse;
  const video = payload.items?.[0];
  if (!video) throw new Error("The scheduled YouTube video no longer exists.");
  return video;
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as Partial<T>;
}

export function assertScheduledVideoAccepted(
  video: YouTubeVideo,
  input: DraftRequest,
  expectedVideoId: string,
): AcceptedYouTubeVideo {
  if (video.id !== expectedVideoId) throw new Error("YouTube returned a different video ID.");
  const uploadStatus = video.status?.uploadStatus ?? "unknown";
  if (!["uploaded", "processed"].includes(uploadStatus)) {
    const reason = video.status?.failureReason ?? video.status?.rejectionReason ?? uploadStatus;
    throw new Error(`YouTube did not accept the upload: ${reason}.`);
  }
  if (video.status?.privacyStatus !== "private") {
    throw new Error("YouTube did not keep the video private until its scheduled publish time.");
  }
  const publishAt = video.status.publishAt;
  if (!publishAt || !sameSecond(publishAt, input.scheduledAt)) {
    throw new Error("YouTube did not retain the requested scheduled publish time.");
  }

  const warnings: string[] = [];
  if (video.snippet?.title !== input.title.trim() || video.snippet.description !== input.description) {
    warnings.push("YouTube accepted the schedule, but the returned title or description differed.");
  }
  if (video.status.selfDeclaredMadeForKids !== input.youtube.madeForKids) {
    warnings.push("YouTube accepted the schedule, but did not echo the made-for-kids setting.");
  }
  return { videoId: expectedVideoId, uploadStatus, publishAt, warnings };
}

async function googleError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; error_description?: string };
    return payload.error?.message ?? payload.error_description ?? `${fallback} (HTTP ${response.status})`;
  } catch {
    return `${fallback} (HTTP ${response.status})`;
  }
}

function sameSecond(left: string, right: string | null): boolean {
  if (!right) return false;
  return Math.abs(new Date(left).getTime() - new Date(right).getTime()) < 1000;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
