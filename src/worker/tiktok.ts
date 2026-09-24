import type { DraftRequest, TikTokCreatorInfo } from "../shared/contracts";
import { providerError } from "./oauth-common";

const API_ROOT = "https://open.tiktokapis.com/v2/post/publish";
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

interface TikTokApiEnvelope<T> {
  data?: T;
  error?: {
    code?: string;
    message?: string;
    log_id?: string;
    logid?: string;
  };
}

interface CreatorInfoPayload {
  creator_username?: string;
  creator_nickname?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

interface InitPayload {
  publish_id?: string;
  upload_url?: string;
}

export interface TikTokRawStatus {
  status: string;
  failReason?: string;
  uploadedBytes: number;
  postIds: string[];
}

export async function queryTikTokCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
  const payload = await tiktokRequest<CreatorInfoPayload>(
    `${API_ROOT}/creator_info/query/`,
    accessToken,
    {},
    "TikTok could not load creator posting settings.",
  );
  if (
    !payload.creator_username ||
    !payload.creator_nickname ||
    !Array.isArray(payload.privacy_level_options) ||
    typeof payload.comment_disabled !== "boolean" ||
    typeof payload.duet_disabled !== "boolean" ||
    typeof payload.stitch_disabled !== "boolean" ||
    typeof payload.max_video_post_duration_sec !== "number"
  ) {
    throw new Error("TikTok returned incomplete creator posting settings.");
  }
  return {
    username: payload.creator_username,
    nickname: payload.creator_nickname,
    privacyLevelOptions: payload.privacy_level_options,
    commentDisabled: payload.comment_disabled,
    duetDisabled: payload.duet_disabled,
    stitchDisabled: payload.stitch_disabled,
    maxVideoDurationSeconds: payload.max_video_post_duration_sec,
  };
}

export async function initializeTikTokDirectPost(
  input: DraftRequest,
  accessToken: string,
  creator: TikTokCreatorInfo,
): Promise<{ publishId: string; uploadUrl: string; chunkSize: number; totalChunkCount: number }> {
  validateCreatorSettings(input, creator);
  const { chunkSize, totalChunkCount } = calculateTikTokChunks(input.assets.video.size);
  const caption = input.description || input.title;
  const payload = await tiktokRequest<InitPayload>(
    `${API_ROOT}/video/init/`,
    accessToken,
    {
      post_info: {
        title: caption,
        privacy_level: "SELF_ONLY",
        disable_comment: !input.tiktok.allowComments,
        disable_duet: !input.tiktok.allowDuet,
        disable_stitch: !input.tiktok.allowStitch,
        video_cover_timestamp_ms: input.tiktok.coverTimestampMs,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: input.assets.video.size,
        chunk_size: chunkSize,
        total_chunk_count: totalChunkCount,
      },
    },
    "TikTok refused to initialize Direct Post.",
  );
  if (!payload.publish_id || !payload.upload_url) {
    throw new Error("TikTok did not return a publish ID and FILE_UPLOAD URL.");
  }
  return {
    publishId: payload.publish_id,
    uploadUrl: payload.upload_url,
    chunkSize,
    totalChunkCount,
  };
}

export async function fetchTikTokPostStatus(
  publishId: string,
  accessToken: string,
): Promise<TikTokRawStatus> {
  const payload = await tiktokRequest<{
    status?: string;
    fail_reason?: string;
    uploaded_bytes?: number;
    publicaly_available_post_id?: Array<string | number>;
  }>(
    `${API_ROOT}/status/fetch/`,
    accessToken,
    { publish_id: publishId },
    "TikTok could not read the Direct Post status.",
  );
  if (!payload.status) throw new Error("TikTok returned an incomplete Direct Post status.");
  return {
    status: payload.status,
    failReason: payload.fail_reason,
    uploadedBytes: payload.uploaded_bytes ?? 0,
    postIds: (payload.publicaly_available_post_id ?? []).map(String),
  };
}

export function calculateTikTokChunks(videoSize: number): {
  chunkSize: number;
  totalChunkCount: number;
} {
  if (videoSize <= MAX_CHUNK_SIZE) return { chunkSize: videoSize, totalChunkCount: 1 };
  const chunkSize = videoSize <= MAX_CHUNK_SIZE * 2
    ? Math.floor(videoSize / 2)
    : MAX_CHUNK_SIZE;
  return {
    chunkSize,
    totalChunkCount: Math.floor(videoSize / chunkSize),
  };
}

export function validateCreatorSettings(input: DraftRequest, creator: TikTokCreatorInfo): void {
  if (!creator.privacyLevelOptions.includes("SELF_ONLY")) {
    throw new Error("TikTok did not offer SELF_ONLY for this creator; the unaudited app will not bypass that restriction.");
  }
  if (input.videoDurationSeconds > creator.maxVideoDurationSeconds + 0.05) {
    throw new Error(
      `This video is ${Math.ceil(input.videoDurationSeconds)} seconds, above this TikTok creator's ${creator.maxVideoDurationSeconds}-second limit.`,
    );
  }
  if (input.tiktok.allowComments && creator.commentDisabled) {
    throw new Error("TikTok reports that comments are disabled for this creator.");
  }
  if (input.tiktok.allowDuet && creator.duetDisabled) {
    throw new Error("TikTok reports that Duet is disabled for this creator.");
  }
  if (input.tiktok.allowStitch && creator.stitchDisabled) {
    throw new Error("TikTok reports that Stitch is disabled for this creator.");
  }
  if (input.tiktok.coverTimestampMs >= Math.ceil(input.videoDurationSeconds * 1000)) {
    throw new Error("TikTok cover timestamp must be inside the video duration.");
  }
}

async function tiktokRequest<T>(
  url: string,
  accessToken: string,
  body: unknown,
  fallback: string,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
  });
  const envelope = (await response.json()) as TikTokApiEnvelope<T>;
  const code = envelope.error?.code;
  if (!response.ok || code !== "ok" || !envelope.data) {
    const logId = envelope.error?.log_id ?? envelope.error?.logid;
    const detail = envelope.error?.message ?? providerError(envelope, fallback);
    throw new Error(`${detail || fallback}${logId ? ` (TikTok log ${logId})` : ""}`);
  }
  return envelope.data;
}
