import type { DraftRequest } from "../shared/contracts";

interface YouTubeVideo {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
  };
  status?: {
    uploadStatus?: string;
    failureReason?: string;
    rejectionReason?: string;
    privacyStatus?: string;
    publishAt?: string;
    selfDeclaredMadeForKids?: boolean;
  };
  processingDetails?: {
    processingStatus?: string;
    processingFailureReason?: string;
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
  url.searchParams.set("part", "snippet,status,processingDetails");
  url.searchParams.set("id", videoId);
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(await googleError(response, "Could not verify the YouTube upload."));
  const payload = (await response.json()) as VideoListResponse;
  const video = payload.items?.[0];
  if (!video) throw new Error("YouTube did not return the uploaded video for verification.");
  return assertScheduledVideoAccepted(video, input, videoId);
}

export function assertScheduledVideoAccepted(
  video: YouTubeVideo,
  input: DraftRequest,
  expectedVideoId: string,
): AcceptedYouTubeVideo {
  const uploadStatus = video.status?.uploadStatus ?? "unknown";
  if (!["uploaded", "processed"].includes(uploadStatus)) {
    const reason = video.status?.failureReason ?? video.status?.rejectionReason ?? uploadStatus;
    throw new Error(`YouTube did not accept the upload: ${reason}.`);
  }
  if (video.processingDetails?.processingStatus === "failed") {
    throw new Error(
      `YouTube processing failed: ${video.processingDetails.processingFailureReason ?? "unknown reason"}.`,
    );
  }
  if (video.id !== expectedVideoId) throw new Error("YouTube returned a different video ID.");
  if (video.snippet?.title !== input.title.trim() || video.snippet.description !== input.description) {
    throw new Error("YouTube did not retain the requested title and description.");
  }
  if (video.status?.privacyStatus !== "private") {
    throw new Error("YouTube did not keep the video private until its scheduled publish time.");
  }
  if (video.status.selfDeclaredMadeForKids !== input.youtube.madeForKids) {
    throw new Error("YouTube did not retain the made-for-kids setting.");
  }
  const publishAt = video.status.publishAt;
  if (!publishAt || !sameSecond(publishAt, input.scheduledAt)) {
    throw new Error("YouTube did not retain the requested scheduled publish time.");
  }
  return { videoId: expectedVideoId, uploadStatus, publishAt };
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
